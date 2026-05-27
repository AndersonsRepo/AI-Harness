#!/usr/bin/env python3
"""Regenerate vault/topics/<slug>.md — the high-priority topic-page layer.

This is the topic-page sibling of regen-project-knowledge.py (the "wiki
maintainer" for project-knowledge pages). Topic pages are injected at
priority 2 in context-assembler.ts, ABOVE raw learnings, with a 20K cap.

Two jobs:
  1. REGENERATE existing pages from their curated `generated_from` sources
     + project/slug-tagged learnings. LLM writes the body; the script
     preserves the HUMAN-EDIT zone byte-for-byte and the structural
     frontmatter (topic/parent/sub_topics). Dirty-bit gated.
  2. DETECT-MISSING: scan registered projects + LIVE_STATE stanzas and report
     which ones have accumulated enough state to warrant a page but don't have
     one yet. Report-only by default (the AI authors via the /topic-page
     skill); --create-missing scaffolds empty stubs.

HUMAN-EDIT zone is preserved byte-for-byte by structural assembly: the LLM
never sees the block. Defaults to dry-run (writes <slug>.md.regenerated).

KNOWN LIMIT — STALE SOURCES: this synthesizes blind from learnings and will
repeat a stale source as a confident current-state fact (proven: a
regression-replay regen claimed heartbeats "never installed" when they had 170
healthy runs). The prompt CANNOT fix this — the model has no ground truth. The
controls are (1) source hygiene, (2) the --propose review gate, and (3) the
planned pre-apply FRESHNESS GATE: before auto-applying, verify the regen's
checkable claims against ground truth (fs/git/launchctl/curl) and, on mismatch,
fix the source then re-regenerate. The procedure to implement is codified in
`.claude/skills/topic-page/SKILL.md` → "Freshness verification". Until that gate
exists, auto-apply is only safe for fresh-source (active) projects; old/dormant
projects should be hand-authored via the skill. See
vault LRN-topic-maintainer-stale-source-hallucination-2026-05-26.

Usage:
    python3 regen-topic-pages.py --topic hey-lexxi
    python3 regen-topic-pages.py --topic hey-lexxi --apply
    python3 regen-topic-pages.py --all --auto            # dirty-gated, applies
    python3 regen-topic-pages.py --topic sigmas-internship --no-llm
    python3 regen-topic-pages.py --detect-missing
"""

from __future__ import annotations

import argparse
import datetime
import difflib
import json
import os
import re
import subprocess
import sys

HARNESS_ROOT = os.environ.get(
    "HARNESS_ROOT",
    os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))),
)
TASKS_DIR = os.path.join(HARNESS_ROOT, "heartbeat-tasks")
VAULT_DIR = os.path.join(HARNESS_ROOT, "vault")
TOPICS_DIR = os.path.join(VAULT_DIR, "topics")
LEARNINGS_DIR = os.path.join(VAULT_DIR, "learnings")
KNOWLEDGE_DIR = os.path.join(VAULT_DIR, "shared", "project-knowledge")
PROJECTS_FILE = os.path.join(TASKS_DIR, "projects.json")
LIVE_STATE_FILE = os.path.join(VAULT_DIR, "LIVE_STATE.md")

sys.path.insert(0, TASKS_DIR)
from lib.llm_provider import get_provider, get_default_model, LLMError  # noqa: E402

MAX_ENTRIES = 80
MAX_BODY_CHARS = 1500       # per learning entry in the prompt
MAX_SOURCE_CHARS = 6000     # per non-learning source file in the prompt
# Curated `generated_from` learnings are authoritative and always included.
# Tag-matched learnings only TOP UP freshness — at most this many of the most
# recent ones not already curated. The SIGMAS page proved that a tight, curated
# source set (6 dedicated learnings) beats an 80-entry tag dump for synthesis
# quality, and it bounds prompt size/cost on heavily-tagged projects (ai-harness).
TAG_MATCH_CAP = 12

# Sources that are consumers/indexes, never inputs (avoids circular eager-dirty).
SOURCE_BLOCKLIST = {"vault/LIVE_STATE.md"}

# Detection thresholds for --detect-missing.
DETECT_MIN_STANZA_CHARS = 600   # LIVE_STATE stanza this big → wants its own page
DETECT_MIN_LEARNINGS = 5        # this many tagged learnings → wants its own page

HUMAN_EDIT_START_RE = re.compile(r"<!--\s*HUMAN-EDIT START.*?-->", re.DOTALL)
HUMAN_EDIT_END_LITERAL = "<!-- HUMAN-EDIT END -->"

DEFAULT_HUMAN_EDIT_BLOCK = (
    "<!-- HUMAN-EDIT START — optional, rarely used. Anything between these markers "
    "is preserved verbatim across AI rewrites; the AI will not touch it. Drop in a "
    "North Star, a principle, or a hard constraint you want every agent to "
    "internalize. Usually empty. -->\n"
    "<!-- HUMAN-EDIT END -->"
)


SYSTEM_PROMPT = """You are a wiki maintainer producing the body of a vault TOPIC PAGE.

A topic page is the durable, load-bearing synthesis of one project/topic. It is injected into every agent's context for this project at HIGH priority — above raw learnings — so density and signal matter. You are NOT writing a changelog.

Rules:
1. Output ONLY the body content. Do NOT emit frontmatter, the H1 title, or HUMAN-EDIT markers — the script assembles those. If a Parent line is needed it is added by the script too. Start at your first `## ` heading (or the `**Parent:**` line if one is supplied in the input).
2. Domain-fit the sections to the topic — don't force a fixed template. Good defaults: `## What this is`, `## Current State`, `## Key Architecture`, `## Known Gotchas`, `## Active Decisions`, `## Open Follow-ups`, `## Related Reading`. But a company/engagement page wants sections like Funding / Business model / Culture / Key people; a tech subsystem wants Architecture / Gotchas / Decisions. Skip empty sections, add what fits.
3. Synthesize — group related facts, do not transcribe entries one-by-one. Prefer concrete facts (file paths, commit SHAs, resource IDs, numbers, error messages) over narrative.
4. Cite vault entry IDs with wikilinks when referencing specific facts, e.g. `[[LRN-20260516-004]]`, `[[ERR-20260516-001]]`.
5. Point to the project-knowledge page and source plans for depth rather than duplicating them.
6. If two sources contradict, prefer the more recent and note the supersession.
7. For confidential projects (any source says "confidential" / "local-only" / "do not push"), emit a one-line local-only banner at the very top of the body.
8. GROUND EVERYTHING IN THE SOURCES. Assert only what the provided sources support. If a fact you'd want is absent, write `_(TBD — <what's missing>)_` rather than inventing it — honest gaps are a feature (the human fills them in). This is the single most important rule.
9. NEVER state a dated or past-tense source claim as the live current state. Source learnings can be stale relative to reality. If a claim's currency isn't confirmed, hedge it ("as of <date> …") or move it under a clearly historical heading — do not assert it in `## Current State`. (Over-confident stale facts in this high-priority page are the main failure mode of this job.)
10. Surface the implication, not just the fact — where the sources support it, say why a fact matters or what to do about it. But never reason beyond what the sources establish.
"""


# ─── Frontmatter parsing (handles inline AND block-list values) ───────────


def parse_frontmatter(content: str) -> tuple[dict, str]:
    m = re.match(r"^---\n(.*?)\n---\n?", content, re.DOTALL)
    if not m:
        return {}, content
    fm_text = m.group(1)
    rest = content[m.end():]
    fm: dict = {}
    lines = fm_text.splitlines()
    i = 0
    while i < len(lines):
        line = lines[i]
        if not line.strip() or line.lstrip().startswith("#"):
            i += 1
            continue
        k, sep, v = line.partition(":")
        if not sep:
            i += 1
            continue
        k = k.strip()
        v = v.strip()
        if v.startswith("[") and v.endswith("]"):
            inner = v[1:-1]
            fm[k] = [x.strip().strip('"').strip("'") for x in inner.split(",") if x.strip()]
        elif v == "":
            # Possible YAML block list on following indented `- ` lines.
            items: list[str] = []
            j = i + 1
            while j < len(lines):
                im = re.match(r"^\s+-\s*(.+?)\s*$", lines[j])
                if im:
                    items.append(im.group(1).strip().strip('"').strip("'"))
                    j += 1
                    continue
                if lines[j].strip() == "":
                    j += 1
                    continue
                break
            fm[k] = items if items else ""
            i = j
            continue
        else:
            fm[k] = v.strip('"').strip("'")
        i += 1
    return fm, rest


# ─── Entry selection ──────────────────────────────────────────────────


def _read_learning(fpath: str) -> dict | None:
    try:
        with open(fpath) as f:
            content = f.read()
    except OSError:
        return None
    fm, body = parse_frontmatter(content)
    status = (fm.get("status") or "").strip().lower()
    if status in ("archived", "superseded"):
        return None
    title_m = re.search(r"^#\s+(.+)$", body, re.MULTILINE)
    if title_m:
        title = title_m.group(1).strip()
        body_text = body[title_m.end():].strip()
    else:
        title = fm.get("id", os.path.basename(fpath)[:-3])
        body_text = body.strip()
    return {
        "path": os.path.relpath(fpath, HARNESS_ROOT),
        "id": fm.get("id", os.path.basename(fpath)[:-3]),
        "type": fm.get("type", ""),
        "status": status or "active",
        "last_seen": fm.get("last-seen") or fm.get("logged") or fm.get("created") or "",
        "title": title,
        "body": body_text[:MAX_BODY_CHARS],
        "tags": [t.lower() for t in (fm.get("tags") or [])] if isinstance(fm.get("tags"), list)
                else [t.strip().lower() for t in (fm.get("tags") or "").split(",") if t.strip()],
    }


def select_tagged_learnings(slug: str) -> list[dict]:
    """Learnings tagged `project: <slug>` or with <slug> in tags. Newest first."""
    out: list[dict] = []
    if not os.path.isdir(LEARNINGS_DIR):
        return out
    for fname in sorted(os.listdir(LEARNINGS_DIR)):
        if not fname.endswith(".md"):
            continue
        fpath = os.path.join(LEARNINGS_DIR, fname)
        try:
            with open(fpath) as f:
                fm, _ = parse_frontmatter(f.read())
        except OSError:
            continue
        project = (fm.get("project") or "").strip()
        tags = fm.get("tags") or []
        if isinstance(tags, str):
            tags = [t.strip() for t in tags.split(",")]
        tags = [t.lower() for t in tags]
        if project != slug and slug.lower() not in tags:
            continue
        e = _read_learning(fpath)
        if e:
            out.append(e)
    out.sort(key=lambda e: e["last_seen"], reverse=True)
    return out[:MAX_ENTRIES]


def gather_sources(slug: str, generated_from: list[str]) -> tuple[list[dict], list[dict]]:
    """Return (learning_entries, file_sources).

    learning_entries: curated generated_from learnings ∪ slug-tagged learnings.
    file_sources: curated generated_from non-learning files (plans, project-knowledge),
                  excluding the LIVE_STATE consumer index and pseudo-entries.
    """
    learnings: dict[str, dict] = {}
    files: list[dict] = []

    for rel in generated_from or []:
        rel = rel.strip()
        if not rel or rel in SOURCE_BLOCKLIST or "(" in rel:  # skip "(file listing)" pseudo-entries
            continue
        abspath = os.path.join(HARNESS_ROOT, rel)
        if rel.startswith("vault/learnings/"):
            e = _read_learning(abspath)
            if e:
                learnings[e["path"]] = e
            continue
        if not os.path.isfile(abspath):
            continue
        try:
            with open(abspath) as f:
                text = f.read()
        except OSError:
            continue
        files.append({"path": rel, "content": text[:MAX_SOURCE_CHARS],
                      "truncated": len(text) > MAX_SOURCE_CHARS})

    added = 0
    for e in select_tagged_learnings(slug):  # newest-first
        if e["path"] in learnings:
            continue
        if added >= TAG_MATCH_CAP:
            break
        learnings[e["path"]] = e
        added += 1

    learning_list = sorted(learnings.values(), key=lambda e: e["last_seen"], reverse=True)
    return learning_list, files


# ─── Dirty-bit ──────────────────────────────────────────────────────────


def git_last_commit_date(rel_path: str) -> str:
    try:
        r = subprocess.run(
            ["git", "log", "-1", "--format=%cI", "--", rel_path],
            cwd=HARNESS_ROOT, capture_output=True, text=True, timeout=10,
        )
        if r.returncode == 0:
            return (r.stdout.strip() or "")[:10]
    except (OSError, subprocess.SubprocessError):
        pass
    return ""


def is_topic_dirty(slug: str, fm: dict, learnings: list[dict], files: list[dict]) -> tuple[bool, str]:
    if not learnings and not files:
        return False, "no regenerable sources — leave as hand-authored"
    last_synth = (fm.get("last_synthesized_at") or "").strip()
    if not last_synth:
        return True, "page has no last_synthesized_at"
    synth_date = last_synth[:10]
    newest = ""
    for e in learnings:
        if e["last_seen"] and e["last_seen"][:10] > newest:
            newest = e["last_seen"][:10]
    for f in files:
        d = git_last_commit_date(f["path"])
        if d > newest:
            newest = d
    if newest and newest > synth_date:
        return True, f"source {newest} > synth {synth_date}"
    return False, f"sources <= synth {synth_date}"


# ─── HUMAN-EDIT zone ──────────────────────────────────────────────────


def extract_human_edit_zone(content: str) -> str | None:
    start = HUMAN_EDIT_START_RE.search(content)
    if not start:
        return None
    end = content.find(HUMAN_EDIT_END_LITERAL, start.end())
    if end == -1:
        return None
    return content[start.start():end + len(HUMAN_EDIT_END_LITERAL)]


# ─── LLM ────────────────────────────────────────────────────────────────


def build_user_prompt(slug: str, fm: dict, learnings: list[dict], files: list[dict]) -> str:
    parent = fm.get("parent")
    parent = None if (not parent or parent == "null") else parent
    lines = [f"Topic slug: {slug}"]
    if parent:
        lines.append(f"Parent topic: {parent} (begin the body with a `**Parent:** [[{parent}]]` line)")
    lines.append("")
    if files:
        lines.append(f"Source documents ({len(files)}):")
        lines.append("")
        for fsrc in files:
            lines.append(f"### SOURCE: {fsrc['path']}" + (" (truncated)" if fsrc["truncated"] else ""))
            lines.append(fsrc["content"])
            lines.append("")
    if learnings:
        lines.append(f"Vault learnings ({len(learnings)}, most recent first):")
        lines.append("")
        for e in learnings:
            meta = [e["id"]] + ([e["type"]] if e["type"] else []) + \
                   ([f"last-seen {e['last_seen']}"] if e["last_seen"] else [])
            lines.append(f"### {e['title']}")
            lines.append(f"_{' · '.join(meta)}_")
            lines.append("")
            lines.append(e["body"])
            lines.append("")
    lines.append("---")
    lines.append(
        "Produce the topic-page body now. Start at your first `## ` heading "
        "(or the `**Parent:**` line if a parent was supplied). No frontmatter, "
        "no H1, no HUMAN-EDIT markers — the script adds those."
    )
    return "\n".join(lines)


def call_llm(user_prompt: str) -> str:
    llm = get_provider()
    response = llm.complete(
        user_prompt,
        model=get_default_model(),
        system_prompt=SYSTEM_PROMPT,
        timeout=240,
        max_turns=1,
        cwd=HARNESS_ROOT,
    )
    body = response.text.strip()
    if body.startswith("```"):
        body = re.sub(r"^```[\w-]*\n", "", body)
        body = re.sub(r"\n```\s*$", "", body)
    body = HUMAN_EDIT_START_RE.sub("", body)
    body = body.replace(HUMAN_EDIT_END_LITERAL, "")
    return body.strip()


# ─── Assembly ─────────────────────────────────────────────────────────


def get_current_sha() -> str:
    try:
        r = subprocess.run(["git", "rev-parse", "HEAD"], cwd=HARNESS_ROOT,
                           capture_output=True, text=True, timeout=5)
        if r.returncode == 0:
            return r.stdout.strip()
    except (OSError, subprocess.SubprocessError):
        pass
    return ""


def _fmt_list(key: str, items: list[str]) -> str:
    if not items:
        return f"{key}: []\n"
    return f"{key}:\n" + "".join(f"  - {x}\n" for x in items)


def assemble_file(slug: str, fm: dict, learnings: list[dict], files: list[dict],
                  human_edit_block: str, llm_body: str) -> str:
    sha = get_current_sha()
    now = datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    title = fm.get("title_override") or slug.replace("-", " ").title()
    # Special-case nicer titles for known acronyms.
    title = {"ai-harness": "AI Harness", "sigmas-internship": "SIGMAS Internship"}.get(slug, title)
    parent = fm.get("parent") or "null"
    sub_topics = fm.get("sub_topics") if isinstance(fm.get("sub_topics"), list) else []
    sources = sorted({e["path"] for e in learnings} | {f["path"] for f in files})

    frontmatter = (
        "---\n"
        f"id: TOPIC-{slug}\n"
        "type: topic\n"
        f"topic: {slug}\n"
        f"parent: {parent}\n"
        + _fmt_list("sub_topics", sub_topics)
        + "status: active\n"
        "managed_by: regen-topic-pages\n"
        f"last_synthesized_at: {now}\n"
        f"last_synthesis_sha: {sha}\n"
        + _fmt_list("generated_from", sources)
        + "---\n\n"
    )
    return (
        frontmatter
        + f"# {title}\n\n"
        + human_edit_block.rstrip()
        + "\n\n"
        + llm_body.strip()
        + "\n"
    )


def show_diff(path: str, new_content: str) -> None:
    old = ""
    if os.path.exists(path):
        with open(path) as f:
            old = f.read()
    sys.stdout.writelines(difflib.unified_diff(
        old.splitlines(keepends=True), new_content.splitlines(keepends=True),
        fromfile=f"{os.path.relpath(path, HARNESS_ROOT)} (current)",
        tofile=f"{os.path.relpath(path, HARNESS_ROOT)} (regenerated)", n=3,
    ))


# ─── Regenerate one ───────────────────────────────────────────────────


def list_topic_slugs() -> list[str]:
    if not os.path.isdir(TOPICS_DIR):
        return []
    return sorted(f[:-3] for f in os.listdir(TOPICS_DIR) if f.endswith(".md"))


def regen_one(slug: str, apply_changes: bool, no_llm: bool, auto: bool,
              force: bool, check_only: bool, propose: bool = False) -> int:
    path = os.path.join(TOPICS_DIR, f"{slug}.md")
    if not os.path.exists(path):
        print(f"[{slug}] no such topic page", file=sys.stderr)
        return 1
    with open(path) as f:
        existing = f.read()
    fm, _ = parse_frontmatter(existing)
    # Only manage actual topic pages (type: topic). Catalog/index pages like
    # skills.md (type: learning) have their own provenance and aren't project
    # syntheses — leave them alone.
    if (fm.get("type") or "").strip() != "topic":
        if not check_only:
            print(f"[{slug}] not a topic page (type={fm.get('type')!r}) — skipping", file=sys.stderr)
        return 0
    gen_from = fm.get("generated_from") if isinstance(fm.get("generated_from"), list) else []
    learnings, files = gather_sources(slug, gen_from)

    if check_only:
        dirty, reason = is_topic_dirty(slug, fm, learnings, files)
        print(f"[{slug}] {'DIRTY' if dirty else 'CLEAN'} — {reason}", file=sys.stderr)
        return 1 if dirty else 0

    # --auto and --propose both dirty-bit gate; --auto APPLIES, --propose only
    # writes a .regenerated proposal for review (safe default for the heartbeat,
    # since LLM synthesis from possibly-stale learnings can introduce wrong
    # current-state facts into this high-priority context layer).
    if (auto or propose) and not force:
        dirty, reason = is_topic_dirty(slug, fm, learnings, files)
        if not dirty:
            print(f"[{slug}] clean — skipped ({reason})", file=sys.stderr)
            return 0
        verb = "regenerating" if auto else "proposing"
        print(f"[{slug}] dirty — {verb} ({reason})", file=sys.stderr)
        if auto:
            apply_changes = True

    if not learnings and not files:
        print(f"[{slug}] no regenerable sources (hand-authored only) — skipping", file=sys.stderr)
        return 0

    human_edit = extract_human_edit_zone(existing) or DEFAULT_HUMAN_EDIT_BLOCK
    print(f"[{slug}] {len(learnings)} learnings + {len(files)} files · "
          f"HUMAN-EDIT {'existing' if extract_human_edit_zone(existing) else 'default'} "
          f"({len(human_edit)} chars)", file=sys.stderr)

    if no_llm:
        for f in files:
            print(f"  file: {f['path']}", file=sys.stderr)
        for e in learnings:
            print(f"  lrn:  {e['id']:34s} {e['last_seen']:12s} {e['title'][:60]}", file=sys.stderr)
        return 0

    user_prompt = build_user_prompt(slug, fm, learnings, files)
    print(f"[{slug}] calling LLM ({len(user_prompt)} char prompt, timeout 240s)", file=sys.stderr)
    try:
        llm_body = call_llm(user_prompt)
    except LLMError as e:
        print(f"[{slug}] LLM error: {e}", file=sys.stderr)
        return 1

    new_content = assemble_file(slug, fm, learnings, files, human_edit, llm_body)
    if human_edit.rstrip() not in new_content:
        print(f"[{slug}] FATAL: assembled file missing HUMAN-EDIT block. Refusing to write.",
              file=sys.stderr)
        return 1

    if apply_changes:
        tmp = path + ".tmp"
        with open(tmp, "w") as f:
            f.write(new_content)
        os.rename(tmp, path)
        print(f"[{slug}] applied → {path}", file=sys.stderr)
    else:
        regen_path = path + ".regenerated"
        with open(regen_path, "w") as f:
            f.write(new_content)
        print(f"[{slug}] dry-run → {regen_path}", file=sys.stderr)
        print(f"\n=== DIFF: {slug} ===\n", file=sys.stderr)
        show_diff(path, new_content)
    return 0


# ─── Detect missing ───────────────────────────────────────────────────


def live_state_stanzas() -> list[tuple[str, int]]:
    """Return (header_text, char_count) for each LIVE_STATE `### ` stanza."""
    out: list[tuple[str, int]] = []
    if not os.path.exists(LIVE_STATE_FILE):
        return out
    with open(LIVE_STATE_FILE) as f:
        lines = f.read().splitlines()
    cur_header, cur_len = None, 0
    for line in lines:
        if line.startswith("### "):
            if cur_header is not None:
                out.append((cur_header, cur_len))
            cur_header, cur_len = line[4:].strip(), 0
        elif line.startswith("## "):
            if cur_header is not None:
                out.append((cur_header, cur_len))
            cur_header, cur_len = None, 0
        elif cur_header is not None:
            cur_len += len(line) + 1
    if cur_header is not None:
        out.append((cur_header, cur_len))
    return out


def _words(text: str) -> set[str]:
    return set(re.findall(r"[a-z0-9]+", text.lower()))


def detect_missing() -> int:
    existing = set(list_topic_slugs())
    existing_word_sets = {s: _words(s) for s in existing}
    candidates: list[tuple[str, str]] = []
    seen_words: list[set[str]] = [w for w in existing_word_sets.values()]

    # 1) Registered projects with enough tagged learnings.
    try:
        with open(PROJECTS_FILE) as f:
            projects = json.load(f).get("projects", {})
    except (OSError, json.JSONDecodeError):
        projects = {}
    for slug in projects:
        if slug in existing:
            continue
        n = len(select_tagged_learnings(slug))
        if n >= DETECT_MIN_LEARNINGS:
            candidates.append((slug, f"{n} tagged learnings (≥{DETECT_MIN_LEARNINGS})"))
            seen_words.append(_words(slug))

    # 2) LIVE_STATE stanzas that have grown large — unless an existing page (or
    #    an already-flagged candidate) already covers the topic (all of its
    #    slug-words appear in the stanza header).
    for header, size in live_state_stanzas():
        if size < DETECT_MIN_STANZA_CHARS:
            continue
        hw = _words(header)
        if any(ws and ws <= hw for ws in seen_words):
            continue
        candidates.append((header, f"LIVE_STATE stanza {size} chars (≥{DETECT_MIN_STANZA_CHARS})"))
        seen_words.append(hw)

    if not candidates:
        print("No projects currently warrant a new topic page.", file=sys.stderr)
        return 0
    print("Projects that look like they want a topic page (none auto-created):", file=sys.stderr)
    for slug, reason in candidates:
        print(f"  • {slug} — {reason}", file=sys.stderr)
    print("\nCreate with the /topic-page skill, or `--create-missing` to scaffold stubs.",
          file=sys.stderr)
    return 0


# ─── Main ─────────────────────────────────────────────────────────────


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--topic", help="single topic slug to regen")
    ap.add_argument("--all", action="store_true", help="regen every page in vault/topics/")
    ap.add_argument("--apply", action="store_true", help="overwrite in place (default: dry-run)")
    ap.add_argument("--no-llm", action="store_true", help="selection-only; list sources, no LLM")
    ap.add_argument("--auto", action="store_true", help="dirty-bit gate; implies --apply")
    ap.add_argument("--propose", action="store_true",
                    help="dirty-bit gate but DRY-RUN only (writes .regenerated + diff, never "
                         "applies). The heartbeat default — review before high-priority pages change.")
    ap.add_argument("--force", action="store_true", help="skip dirty-bit (use with --auto/--propose)")
    ap.add_argument("--check", action="store_true", help="report dirty/clean; exit 1 if dirty")
    ap.add_argument("--detect-missing", action="store_true",
                    help="report projects that warrant a page but lack one")
    args = ap.parse_args()

    if args.detect_missing:
        return detect_missing()
    if not args.topic and not args.all:
        ap.error("provide --topic <slug>, --all, or --detect-missing")

    slugs = list_topic_slugs() if args.all else [args.topic]
    rc = 0
    for slug in slugs:
        rc |= regen_one(slug, apply_changes=args.apply, no_llm=args.no_llm,
                        auto=args.auto, force=args.force, check_only=args.check,
                        propose=args.propose)
    return rc


if __name__ == "__main__":
    sys.exit(main())
