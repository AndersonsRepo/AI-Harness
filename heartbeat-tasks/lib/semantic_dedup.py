"""Semantic-dedup primitive for vault writers.

Two-layer dedup: cheap embedding pre-filter (Ollama) + reviewer LLM judgment.
Implements NOOP from the ADD/UPDATE/DELETE/NOOP four-op pipeline.

See LRN-20260516-003 for design rationale.
See ERR-20260516-001 for the bug this addresses.

Failure modes:
  - Ollama down → return False (treat as distinct, fall back to caller's exact-match dedup)
  - Reviewer LLM call fails → return False (safer: write the item, can be cleaned later)
  - Both safe: false-distinct just lands one more bullet; false-duplicate would lose content
"""

from __future__ import annotations

import json
import math
import os
import re
import sys
import time
import urllib.error
import urllib.request
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional

# Import path setup: we're at heartbeat-tasks/lib/, llm_provider is in same dir
_THIS_DIR = os.path.dirname(os.path.abspath(__file__))
if _THIS_DIR not in sys.path:
    sys.path.insert(0, _THIS_DIR)
from llm_provider import get_provider, get_default_model  # noqa: E402


OLLAMA_URL = os.environ.get("OLLAMA_URL", "http://localhost:11434/api/embeddings")
OLLAMA_MODEL = os.environ.get("OLLAMA_EMBED_MODEL", "nomic-embed-text")

# Pre-filter threshold: cosine similarity above this triggers reviewer LLM.
# Lower = more reviewer calls (more accurate, slower). Higher = miss more dupes.
# 0.70 was chosen as a wide net; tune via audit log review.
DEFAULT_SIMILARITY_THRESHOLD = float(os.environ.get("SEMANTIC_DEDUP_THRESHOLD", "0.70"))

# Max candidates passed to reviewer. Cap to keep prompt small.
MAX_CANDIDATES_TO_REVIEW = 5

HARNESS_ROOT = Path(
    os.environ.get(
        "HARNESS_ROOT",
        Path(__file__).resolve().parents[2],
    )
)
AUDIT_LOG_PATH = HARNESS_ROOT / "heartbeat-tasks" / "semantic-dedup-audit.jsonl"


@dataclass
class Candidate:
    """A potential semantic match surfaced by the embedding pre-filter."""
    identifier: str  # title or pattern-key
    text: str        # full text used for embedding
    score: float     # cosine similarity to query


# ─── Embedding ───────────────────────────────────────────────────────


def embed(text: str, timeout: float = 5.0) -> Optional[list[float]]:
    """Call Ollama to embed text. Returns None on failure (caller falls back)."""
    if not text or not text.strip():
        return None
    payload = json.dumps({"model": OLLAMA_MODEL, "prompt": text}).encode("utf-8")
    req = urllib.request.Request(
        OLLAMA_URL,
        data=payload,
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            body = json.loads(resp.read())
            return body.get("embedding")
    except (urllib.error.URLError, urllib.error.HTTPError, TimeoutError, json.JSONDecodeError):
        return None


def cosine(a: list[float], b: list[float]) -> float:
    if not a or not b or len(a) != len(b):
        return 0.0
    dot = sum(x * y for x, y in zip(a, b))
    mag_a = math.sqrt(sum(x * x for x in a))
    mag_b = math.sqrt(sum(x * x for x in b))
    if mag_a == 0 or mag_b == 0:
        return 0.0
    return dot / (mag_a * mag_b)


# ─── Candidate finding ───────────────────────────────────────────────


def find_candidates(
    query_text: str,
    existing: list[tuple[str, str]],
    threshold: float = DEFAULT_SIMILARITY_THRESHOLD,
    max_results: int = MAX_CANDIDATES_TO_REVIEW,
) -> list[Candidate]:
    """Find candidates from `existing` semantically similar to `query_text`.

    existing: list of (identifier, text) pairs where text is what gets embedded.
    Returns top `max_results` candidates above `threshold`, sorted by score desc.
    Returns empty list on embedding failure (caller treats as no dup).
    """
    if not existing:
        return []
    query_emb = embed(query_text)
    if query_emb is None:
        return []
    scored: list[Candidate] = []
    for identifier, text in existing:
        emb = embed(text)
        if emb is None:
            continue
        score = cosine(query_emb, emb)
        if score >= threshold:
            scored.append(Candidate(identifier=identifier, text=text, score=score))
    scored.sort(key=lambda c: c.score, reverse=True)
    return scored[:max_results]


# ─── Reviewer LLM judgment ───────────────────────────────────────────


_REVIEWER_PROMPT = """You are a semantic-deduplication reviewer. Given a NEW item and CANDIDATE existing items, decide if the new item is a semantic duplicate of any candidate.

NEW ITEM:
Title: {new_title}
Body: {new_body}

CANDIDATES (most-similar first):
{candidates_block}

CRITERIA — call it a duplicate ONLY if:
1. Same root cause / observable phenomenon (not just same topic area)
2. Same code site or scope (a Hey-Lexxi GraphN bug and an AI-Harness session-debrief bug are NOT duplicates even if both describe "silent failures")
3. Same actionable lesson — a future reader would learn the same thing

CRITERIA — call it distinct if ANY of:
- Different code path / file / system
- Different concrete failure mode
- Different actionable fix
- Refines or contradicts a prior lesson (handle later via UPDATE/SUPERSEDE; for now treat as distinct so it gets written)

CALIBRATION: when in doubt, return distinct. False-distinct lands one extra bullet (cleanable). False-duplicate loses content (irrecoverable).

OUTPUT EXACTLY THIS JSON (no prose, no markdown fence):
{{"verdict": "duplicate" | "distinct", "matched_id": "<candidate identifier or null>", "reasoning": "<one sentence>"}}
"""


def judge_duplicate(
    new_title: str,
    new_body: str,
    candidates: list[Candidate],
    *,
    model: Optional[str] = None,
    timeout: int = 30,
) -> tuple[bool, Optional[str], str]:
    """Ask reviewer LLM: is new_item a duplicate of any candidate?

    Returns: (is_duplicate, matched_identifier_if_dup, reasoning).
    On failure → (False, None, "<error reason>"). Safe default (don't skip on uncertainty).
    """
    if not candidates:
        return False, None, "no candidates above similarity threshold"

    candidates_block = "\n".join(
        f"{i+1}. [sim={c.score:.3f}] id={c.identifier!r}\n   text: {c.text[:300]}"
        for i, c in enumerate(candidates)
    )
    prompt = _REVIEWER_PROMPT.format(
        new_title=new_title,
        new_body=(new_body or "")[:500],
        candidates_block=candidates_block,
    )

    try:
        llm = get_provider()
        resp = llm.complete(
            prompt,
            model=model or get_default_model(),
            timeout=timeout,
            max_turns=1,
        )
        text = resp.text.strip()
        # Strip code fences if present
        if text.startswith("```"):
            text = re.sub(r"^```(?:json)?\s*\n?", "", text)
            text = re.sub(r"\n?```\s*$", "", text)
        data = json.loads(text)
        verdict = data.get("verdict", "distinct")
        is_dup = verdict == "duplicate"
        matched = data.get("matched_id") if is_dup else None
        reasoning = data.get("reasoning", "")
        return is_dup, matched, reasoning
    except Exception as e:  # noqa: BLE001 — broad catch is intentional (safe fallback)
        return False, None, f"reviewer call failed: {type(e).__name__}: {e}"


# ─── Audit log ───────────────────────────────────────────────────────


def audit_log(
    *,
    context: str,                    # e.g. "append_to_project_knowledge:hey-lexxi.md"
    new_title: str,
    new_body: str = "",
    candidates: list[Candidate] | None = None,
    verdict: bool,
    matched_id: Optional[str],
    reasoning: str,
) -> None:
    """Append one decision to the audit log. Best-effort; never raises."""
    try:
        AUDIT_LOG_PATH.parent.mkdir(parents=True, exist_ok=True)
        entry = {
            "ts": datetime.now(timezone.utc).isoformat(),
            "context": context,
            "new_title": new_title,
            "new_body_preview": (new_body or "")[:200],
            "candidates": [
                {"id": c.identifier, "score": round(c.score, 3), "text": c.text[:200]}
                for c in (candidates or [])
            ],
            "verdict": "duplicate" if verdict else "distinct",
            "matched_id": matched_id,
            "reasoning": reasoning,
        }
        with open(AUDIT_LOG_PATH, "a", encoding="utf-8") as f:
            f.write(json.dumps(entry) + "\n")
    except Exception:  # noqa: BLE001 — audit failures must never break the writer
        pass


# ─── Integration helpers ─────────────────────────────────────────────


_PROJECT_KNOWLEDGE_BULLET_RE = re.compile(r"^\s*-\s+\*\*(.+?)\*\*\s*:\s*(.+)$", re.MULTILINE)


def extract_project_knowledge_bullets(file_content: str) -> list[tuple[str, str]]:
    """Return [(title, body)] for every `- **Title**: body` bullet in the file."""
    return [
        (m.group(1).strip(), m.group(2).strip())
        for m in _PROJECT_KNOWLEDGE_BULLET_RE.finditer(file_content)
    ]


def is_project_knowledge_duplicate(
    new_title: str,
    new_body: str,
    file_content: str,
    *,
    context_label: str = "append_to_project_knowledge",
) -> bool:
    """End-to-end NOOP check for project-knowledge bullet writes.

    Returns True if the new bullet semantically duplicates an existing one.
    Logs the decision to the audit log.
    """
    existing = extract_project_knowledge_bullets(file_content)
    if not existing:
        return False
    # Embed query against (title + ": " + body) for each existing bullet
    query_text = f"{new_title}: {new_body}" if new_body else new_title
    existing_for_embedding = [
        (title, f"{title}: {body}") for title, body in existing
    ]
    candidates = find_candidates(query_text, existing_for_embedding)
    is_dup, matched_id, reasoning = judge_duplicate(new_title, new_body, candidates)
    audit_log(
        context=context_label,
        new_title=new_title,
        new_body=new_body,
        candidates=candidates,
        verdict=is_dup,
        matched_id=matched_id,
        reasoning=reasoning,
    )
    return is_dup


def is_vault_entry_duplicate(
    new_title: str,
    new_body: str,
    new_pattern_key: str,
    existing_entries: list[dict],
    *,
    context_label: str = "write_vault_entry",
) -> tuple[bool, Optional[str]]:
    """NOOP check for vault entry writes.

    existing_entries: list of dicts with keys: id, pattern_key, title, body
    Returns (is_dup, matched_entry_id). Logs to audit.
    """
    if not existing_entries:
        return False, None
    query_text = f"{new_title}: {new_body}" if new_body else new_title
    existing_for_embedding = [
        (e["id"], f"{e.get('title', '')}: {e.get('body', '')}")
        for e in existing_entries
        if e.get("title") or e.get("body")
    ]
    candidates = find_candidates(query_text, existing_for_embedding)
    is_dup, matched_id, reasoning = judge_duplicate(new_title, new_body, candidates)
    audit_log(
        context=context_label,
        new_title=new_title,
        new_body=new_body,
        candidates=candidates,
        verdict=is_dup,
        matched_id=matched_id,
        reasoning=reasoning,
    )
    return is_dup, matched_id


# ─── Vault-entry candidate finder using precomputed embeddings ───────
#
# Powers the SUPERSEDE pipeline in session-debrief.py. Falls back to the
# existing Jaccard-based finder when this can't return a match. Uses the
# precomputed vault-embeddings.json (~1294 entries) to avoid re-embedding
# every existing entry per debrief run.

_VAULT_EMBEDDINGS_PATH = HARNESS_ROOT / "vault" / "vault-embeddings.json"

# Threshold for the vault-entry SUPERSEDE finder.
# Empirically vault embeddings include full file text (frontmatter + body) →
# baseline similarity inflated by YAML overlap → real paraphrases land around
# 0.75-0.80 not 0.85+. Anything above 0.70 is "worth asking decide_conflict_action."
# decide_conflict_action is the safety net for false positives.
DEFAULT_VAULT_SIMILARITY_THRESHOLD = float(
    os.environ.get("VAULT_DEDUP_SIMILARITY_THRESHOLD", "0.70")
)


def _load_vault_embeddings_cache() -> dict[str, list[float]]:
    """Load vault-embeddings.json → {relative_path: embedding}. Best-effort."""
    if not _VAULT_EMBEDDINGS_PATH.exists():
        return {}
    try:
        with open(_VAULT_EMBEDDINGS_PATH, "r", encoding="utf-8") as f:
            data = json.load(f)
        return {e["path"]: e["embedding"] for e in data if e.get("path") and e.get("embedding")}
    except Exception:  # noqa: BLE001
        return {}


def find_vault_match_semantic(
    new_title: str,
    new_body: str,
    existing_entries: list[dict],
    *,
    threshold: float = DEFAULT_VAULT_SIMILARITY_THRESHOLD,
) -> tuple[Optional[dict], float]:
    """Find best existing vault entry semantically similar to a new item.

    existing_entries: list of dicts with at minimum `file_path` (absolute or
    vault-relative). Tries to match against precomputed vault-embeddings.json
    via the file's vault-relative path (e.g. "learnings/LRN-XXX.md").

    Returns (matched_entry_dict, cosine_score) if best match >= threshold,
    else (None, 0.0). Returns (None, 0.0) on any failure.
    """
    if not existing_entries:
        return None, 0.0
    cache = _load_vault_embeddings_cache()
    if not cache:
        return None, 0.0
    query_text = f"{new_title}: {new_body}" if new_body else new_title
    query_emb = embed(query_text)
    if query_emb is None:
        return None, 0.0

    vault_dir = str(HARNESS_ROOT / "vault") + "/"
    best_entry = None
    best_score = 0.0
    for entry in existing_entries:
        fpath = entry.get("file_path", "")
        # Convert absolute → vault-relative for cache lookup
        if fpath.startswith(vault_dir):
            rel = fpath[len(vault_dir):]
        else:
            rel = fpath
        cached_emb = cache.get(rel)
        if cached_emb is None:
            continue
        score = cosine(query_emb, cached_emb)
        if score > best_score:
            best_score = score
            best_entry = entry

    if best_score >= threshold:
        # Audit the semantic-only match so we can review reviewer behavior later
        audit_log(
            context="find_vault_match_semantic",
            new_title=new_title,
            new_body=new_body,
            candidates=[Candidate(
                identifier=best_entry.get("pattern_key", best_entry.get("file_path", "?")),
                text=best_entry.get("title", ""),
                score=best_score,
            )],
            verdict=True,
            matched_id=best_entry.get("pattern_key"),
            reasoning=f"semantic candidate above {threshold} threshold; handed to decide_conflict_action",
        )
        return best_entry, best_score
    return None, 0.0
