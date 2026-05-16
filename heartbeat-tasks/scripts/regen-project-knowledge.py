#!/usr/bin/env python3
"""Regenerate vault/shared/project-knowledge/<project>.md from vault learnings.

Replaces the append-only `append_to_project_knowledge` model with deterministic
regeneration from `vault/learnings/*.md` — the single addressable source of truth.

HUMAN-EDIT zone is preserved byte-for-byte by structural assembly: the LLM never
sees the block. The script reads it from the existing file (or inserts an empty
default) and pastes it back around the LLM-generated body. Defaults to dry-run.

Usage:
    python3 regen-project-knowledge.py --project hey-lexxi
    python3 regen-project-knowledge.py --project hey-lexxi --apply
    python3 regen-project-knowledge.py --all
    python3 regen-project-knowledge.py --project hey-lexxi --no-llm   # selection-only debug
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
LEARNINGS_DIR = os.path.join(VAULT_DIR, "learnings")
KNOWLEDGE_DIR = os.path.join(VAULT_DIR, "shared", "project-knowledge")
PROJECTS_FILE = os.path.join(TASKS_DIR, "projects.json")

sys.path.insert(0, TASKS_DIR)
from lib.llm_provider import get_provider, get_default_model, LLMError  # noqa: E402

MAX_ENTRIES = 80
MAX_BODY_CHARS = 1500

HUMAN_EDIT_START_RE = re.compile(r"<!--\s*HUMAN-EDIT START.*?-->", re.DOTALL)
HUMAN_EDIT_END_LITERAL = "<!-- HUMAN-EDIT END -->"

DEFAULT_HUMAN_EDIT_BLOCK = (
    "<!-- HUMAN-EDIT START — preserved verbatim across regen. "
    "Put north-star vision, principles, or anything every agent should "
    "internalize about this project here. The regenerator will not touch it. -->\n"
    "\n"
    "_(empty)_\n"
    "\n"
    "<!-- HUMAN-EDIT END -->"
)


SYSTEM_PROMPT = """You are a wiki maintainer producing the LLM-managed body of a project-knowledge page.

The page will be loaded into every agent's context window for this project, so density and signal matter more than completeness. You are NOT writing a changelog.

Rules:
1. Output ONLY the body content. Do NOT emit frontmatter, an H1 title, or HUMAN-EDIT markers — those are assembled by the script. Start your output at the first `## ` heading.
2. Group related entries. Do not list them one-by-one. If five entries describe the same gotcha from different angles, write one paragraph that captures it.
3. Use free-form `## ` and `### ` headings that fit the content. No required section list.
4. Cite vault entry IDs in brackets when referencing specific facts, e.g. `[LRN-20260516-004]`, `[ERR-20260516-001]`.
5. Prefer concrete facts (file paths, commit SHAs, numbers, error messages) over narrative.
6. Tight prose over bullet salad. Bullets are fine for lists of things; paragraphs are better for reasoning.
7. If two entries contradict, prefer the more recent one and note the supersession.
"""


# ─── Frontmatter parsing (minimal, no pyyaml dep) ─────────────────────


def parse_frontmatter(content: str) -> tuple[dict, str]:
    m = re.match(r"^---\n(.*?)\n---\n?", content, re.DOTALL)
    if not m:
        return {}, content
    fm_text = m.group(1)
    rest = content[m.end():]
    fm: dict = {}
    for line in fm_text.splitlines():
        if not line.strip() or line.lstrip().startswith("#"):
            continue
        k, sep, v = line.partition(":")
        if not sep:
            continue
        k = k.strip()
        v = v.strip()
        if v.startswith("[") and v.endswith("]"):
            inner = v[1:-1]
            v = [x.strip().strip('"').strip("'") for x in inner.split(",") if x.strip()]
        fm[k] = v
    return fm, rest


# ─── Entry selection ──────────────────────────────────────────────────


def select_project_entries(project_slug: str) -> list[dict]:
    """Vault entries tagged `project: <slug>` or with <slug> in `tags:`.

    Skips archived/superseded. Sorted by last-seen desc, capped to MAX_ENTRIES.
    """
    entries: list[dict] = []
    if not os.path.exists(LEARNINGS_DIR):
        return entries

    for fname in sorted(os.listdir(LEARNINGS_DIR)):
        if not fname.endswith(".md"):
            continue
        fpath = os.path.join(LEARNINGS_DIR, fname)
        try:
            with open(fpath) as f:
                content = f.read()
        except OSError:
            continue

        fm, body = parse_frontmatter(content)
        status = (fm.get("status") or "").strip().lower()
        if status in ("archived", "superseded"):
            continue

        project = (fm.get("project") or "").strip()
        tags = fm.get("tags") or []
        if isinstance(tags, str):
            tags = [t.strip() for t in tags.split(",")]
        tags = [t.lower() for t in tags]

        if project != project_slug and project_slug.lower() not in tags:
            continue

        title_m = re.search(r"^#\s+(.+)$", body, re.MULTILINE)
        if title_m:
            title = title_m.group(1).strip()
            body_text = body[title_m.end():].strip()
        else:
            title = fm.get("id", fname[:-3])
            body_text = body.strip()

        entries.append({
            "path": os.path.relpath(fpath, HARNESS_ROOT),
            "id": fm.get("id", fname[:-3]),
            "type": fm.get("type", ""),
            "status": status or "active",
            "last_seen": fm.get("last-seen") or fm.get("logged") or "",
            "title": title,
            "body": body_text[:MAX_BODY_CHARS],
            "tags": tags,
            "pattern_key": fm.get("pattern-key", ""),
        })

    entries.sort(key=lambda e: e["last_seen"], reverse=True)
    return entries[:MAX_ENTRIES]


# ─── Dirty-bit check ──────────────────────────────────────────────────


def is_project_dirty(project_slug: str) -> tuple[bool, str]:
    """Return (dirty, reason). Dirty = vault has entries newer than the page.

    A project is dirty if:
      - The project-knowledge file does not exist yet
      - The file has no `last_synthesized_at` frontmatter field
      - The max `last-seen` in vault entries for the project is newer than
        `last_synthesized_at`

    Cheap — reads only the project-knowledge frontmatter and the frontmatter
    of every vault entry tagged for the project. No LLM call.
    """
    # Check vault entries first — no entries means nothing to regen regardless
    # of whether the file exists.
    entries = select_project_entries(project_slug)
    if not entries:
        return False, "no vault entries — nothing to regen"

    out_path = os.path.join(KNOWLEDGE_DIR, f"{project_slug}.md")
    if not os.path.exists(out_path):
        return True, "no project-knowledge file yet"

    try:
        with open(out_path) as f:
            content = f.read()
    except OSError as e:
        return True, f"could not read existing page: {e}"

    fm, _ = parse_frontmatter(content)
    last_synth = (fm.get("last_synthesized_at") or "").strip()
    if not last_synth:
        return True, "page has no last_synthesized_at frontmatter"

    max_last_seen = max((e["last_seen"] for e in entries if e["last_seen"]), default="")
    if not max_last_seen:
        return False, "no dated vault entries"

    # last_synth is ISO with 'Z' (e.g. "2026-05-15T03:56:22Z"); last_seen is
    # just a date (e.g. "2026-05-15"). Compare prefixes — if dates differ, the
    # newer date wins; if dates match, treat as clean (intra-day re-runs skip).
    last_synth_date = last_synth[:10]
    if max_last_seen > last_synth_date:
        return True, f"vault {max_last_seen} > synth {last_synth_date}"
    return False, f"vault {max_last_seen} <= synth {last_synth_date}"


# ─── HUMAN-EDIT zone extraction ───────────────────────────────────────


def extract_human_edit_zone(content: str) -> str | None:
    """Return the HUMAN-EDIT span (markers included), byte-exact, or None."""
    start_match = HUMAN_EDIT_START_RE.search(content)
    if not start_match:
        return None
    end_idx = content.find(HUMAN_EDIT_END_LITERAL, start_match.end())
    if end_idx == -1:
        return None
    return content[start_match.start():end_idx + len(HUMAN_EDIT_END_LITERAL)]


# ─── LLM call ─────────────────────────────────────────────────────────


def build_user_prompt(project_slug: str, project_meta: dict, entries: list[dict]) -> str:
    lines = [
        f"Project: {project_slug}",
        f"Description: {project_meta.get('description', '(none)')}",
        f"Repo: {project_meta.get('repo', '(none)')}",
        f"Path: {project_meta.get('path', '(none)')}",
        "",
        f"Vault entries ({len(entries)}, most recent first):",
        "",
    ]
    for e in entries:
        lines.append(f"### {e['title']}")
        meta_parts = [e["id"]]
        if e["type"]:
            meta_parts.append(e["type"])
        if e["last_seen"]:
            meta_parts.append(f"last-seen {e['last_seen']}")
        lines.append(f"_{' · '.join(meta_parts)}_")
        lines.append("")
        lines.append(e["body"])
        lines.append("")

    lines.append("---")
    lines.append(
        "Produce the LLM-managed body now. Start at your first `## ` heading. "
        "No frontmatter, no H1, no HUMAN-EDIT markers — the script adds those."
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
    # Strip code-fence wrapping if the LLM added it
    if body.startswith("```"):
        body = re.sub(r"^```[\w-]*\n", "", body)
        body = re.sub(r"\n```\s*$", "", body)
    # Defensively strip any HUMAN-EDIT markers the LLM hallucinated — the
    # script owns those exclusively.
    body = HUMAN_EDIT_START_RE.sub("", body)
    body = body.replace(HUMAN_EDIT_END_LITERAL, "")
    return body.strip()


# ─── File assembly ────────────────────────────────────────────────────


def get_current_sha() -> str:
    try:
        r = subprocess.run(
            ["git", "rev-parse", "HEAD"],
            cwd=HARNESS_ROOT, capture_output=True, text=True, timeout=5,
        )
        if r.returncode == 0:
            return r.stdout.strip()
    except (OSError, subprocess.SubprocessError):
        pass
    return ""


def assemble_file(
    project_slug: str,
    entries: list[dict],
    human_edit_block: str,
    llm_body: str,
) -> str:
    sha = get_current_sha()
    now = datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    title = project_slug.replace("-", " ").title()
    sources = "\n".join(f"  - {e['path']}" for e in entries)
    frontmatter = (
        f"---\n"
        f"title: {title}\n"
        f"scope: shared\n"
        f"project: {project_slug}\n"
        f"managed_by: regen-project-knowledge\n"
        f"last_synthesized_at: {now}\n"
        f"last_synthesis_sha: {sha}\n"
        f"generated_from:\n{sources}\n"
        f"---\n\n"
    )
    return (
        frontmatter
        + f"# {title}\n\n"
        + human_edit_block.rstrip()
        + "\n\n"
        + llm_body.strip()
        + "\n"
    )


# ─── Dry-run output ───────────────────────────────────────────────────


def show_diff(old_path: str, new_content: str) -> None:
    old = ""
    if os.path.exists(old_path):
        with open(old_path) as f:
            old = f.read()
    diff = difflib.unified_diff(
        old.splitlines(keepends=True),
        new_content.splitlines(keepends=True),
        fromfile=f"{os.path.relpath(old_path, HARNESS_ROOT)} (current)",
        tofile=f"{os.path.relpath(old_path, HARNESS_ROOT)} (regenerated)",
        n=3,
    )
    sys.stdout.writelines(diff)


# ─── Main flow ────────────────────────────────────────────────────────


def regen_one(
    project_slug: str,
    projects: dict,
    apply_changes: bool,
    no_llm: bool,
    auto: bool = False,
    force: bool = False,
    check_only: bool = False,
    min_entries: int = 1,
) -> int:
    if project_slug not in projects:
        print(f"[{project_slug}] unknown project (not in projects.json)", file=sys.stderr)
        return 1

    # --check: report dirty status and exit (no LLM call). Exit 1 if dirty
    # so callers can branch on `$?`.
    if check_only:
        dirty, reason = is_project_dirty(project_slug)
        state = "DIRTY" if dirty else "CLEAN"
        print(f"[{project_slug}] {state} — {reason}", file=sys.stderr)
        return 1 if dirty else 0

    # --auto: dirty-bit gate. If clean, skip silently (exit 0). Implies --apply.
    if auto and not force:
        dirty, reason = is_project_dirty(project_slug)
        if not dirty:
            print(f"[{project_slug}] clean — skipped ({reason})", file=sys.stderr)
            return 0
        print(f"[{project_slug}] dirty — regenerating ({reason})", file=sys.stderr)
        apply_changes = True

    entries = select_project_entries(project_slug)
    if not entries:
        print(f"[{project_slug}] no vault entries matched — skipping", file=sys.stderr)
        return 0
    if len(entries) < min_entries:
        print(
            f"[{project_slug}] only {len(entries)} vault entries "
            f"(min {min_entries}) — skipping to avoid thin page",
            file=sys.stderr,
        )
        return 0

    out_path = os.path.join(KNOWLEDGE_DIR, f"{project_slug}.md")
    existing = ""
    if os.path.exists(out_path):
        with open(out_path) as f:
            existing = f.read()
    human_edit_block = extract_human_edit_zone(existing) or DEFAULT_HUMAN_EDIT_BLOCK

    print(
        f"[{project_slug}] {len(entries)} entries selected · "
        f"HUMAN-EDIT zone {'existing' if extract_human_edit_zone(existing) else 'default'} "
        f"({len(human_edit_block)} chars)",
        file=sys.stderr,
    )

    if no_llm:
        print(f"[{project_slug}] --no-llm: selection-only, not calling LLM. Entries:", file=sys.stderr)
        for e in entries:
            print(f"  - {e['id']:32s} {e['last_seen']:12s} {e['title'][:70]}", file=sys.stderr)
        return 0

    user_prompt = build_user_prompt(project_slug, projects[project_slug], entries)
    print(
        f"[{project_slug}] calling LLM ({len(user_prompt)} char prompt, "
        f"sonnet, timeout 240s)",
        file=sys.stderr,
    )

    try:
        llm_body = call_llm(user_prompt)
    except LLMError as e:
        print(f"[{project_slug}] LLM error: {e}", file=sys.stderr)
        return 1

    new_content = assemble_file(project_slug, entries, human_edit_block, llm_body)

    # Structural guarantee — the assembled file must contain the HUMAN-EDIT
    # block verbatim. If it doesn't, something went very wrong.
    if human_edit_block.rstrip() not in new_content:
        print(
            f"[{project_slug}] FATAL: assembled file missing HUMAN-EDIT block. "
            f"Refusing to write.",
            file=sys.stderr,
        )
        return 1

    if apply_changes:
        os.makedirs(KNOWLEDGE_DIR, exist_ok=True)
        tmp = out_path + ".tmp"
        with open(tmp, "w") as f:
            f.write(new_content)
        os.rename(tmp, out_path)
        print(f"[{project_slug}] applied → {out_path}", file=sys.stderr)
    else:
        regen_path = out_path + ".regenerated"
        with open(regen_path, "w") as f:
            f.write(new_content)
        print(f"[{project_slug}] dry-run → {regen_path}", file=sys.stderr)
        print(f"\n=== DIFF: {project_slug} ===\n", file=sys.stderr)
        show_diff(out_path, new_content)

    return 0


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--project", help="single project slug to regen")
    ap.add_argument("--all", action="store_true", help="regen every project in projects.json")
    ap.add_argument("--apply", action="store_true",
                    help="overwrite <project>.md in place (default: dry-run to .regenerated)")
    ap.add_argument("--no-llm", action="store_true",
                    help="selection-only — list matched entries without calling LLM")
    ap.add_argument("--auto", action="store_true",
                    help="dirty-bit gate: only regen if vault is newer than the page; "
                         "implies --apply. Used by session-debrief.")
    ap.add_argument("--force", action="store_true",
                    help="skip the dirty-bit check (use with --auto for manual override)")
    ap.add_argument("--check", action="store_true",
                    help="report dirty/clean status without regenerating; "
                         "exit 1 if dirty, 0 if clean")
    ap.add_argument("--min-entries", type=int, default=1,
                    help="skip projects with fewer than N vault entries "
                         "(avoids generating thin pages from sparsely-tagged "
                         "projects). Default 1 (off). Set to 3+ for periodic "
                         "--all runs.")
    args = ap.parse_args()

    if not args.project and not args.all:
        ap.error("provide --project <slug> or --all")

    with open(PROJECTS_FILE) as f:
        projects = json.load(f).get("projects", {})

    def run(slug):
        return regen_one(
            slug, projects,
            apply_changes=args.apply,
            no_llm=args.no_llm,
            auto=args.auto,
            force=args.force,
            check_only=args.check,
            min_entries=args.min_entries,
        )

    if args.all:
        rc = 0
        for slug in projects:
            rc |= run(slug)
        return rc
    return run(args.project)


if __name__ == "__main__":
    sys.exit(main())
