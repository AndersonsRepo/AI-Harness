#!/usr/bin/env python3
"""Deterministically compile concise topic pages for context injection.

This MVP is intentionally template-driven. It does not call an LLM and it does
not attempt open-ended summarization. Each topic uses an explicit source list
plus deterministic section extractors so the output is stable and auditable.

Usage:
    python3 build-topic-pages.py
    python3 build-topic-pages.py --topic ai-harness
    python3 build-topic-pages.py --check
"""

from __future__ import annotations

import argparse
import os
import re
import subprocess
import sys
from dataclasses import dataclass
from pathlib import Path


HARNESS_ROOT = Path(
    os.environ.get(
        "HARNESS_ROOT",
        Path(__file__).resolve().parents[2],
    )
)
VAULT_DIR = HARNESS_ROOT / "vault"
TOPICS_DIR = VAULT_DIR / "topics"
LEARNINGS_DIR = VAULT_DIR / "learnings"


@dataclass(frozen=True)
class TopicSpec:
    slug: str
    title: str
    output_path: Path
    source_paths: tuple[str, ...]


TOPICS: dict[str, TopicSpec] = {
    "ai-harness": TopicSpec(
        slug="ai-harness",
        title="AI Harness",
        output_path=TOPICS_DIR / "ai-harness.md",
        source_paths=(
            "plans/context-assembly-cache-2026-04-24.md",
            "plans/d31-orchestrator-codex-2026-04-29.md",
            "plans/whats-next-2026-04-27.md",
        ),
    ),
}


def read_text(relative_path: str) -> str | None:
    path = HARNESS_ROOT / relative_path
    if not path.exists():
        return None
    return path.read_text(encoding="utf-8")


def normalize_inline(text: str) -> str:
    text = re.sub(r"`([^`]+)`", r"\1", text)
    text = re.sub(r"\*\*([^*]+)\*\*", r"\1", text)
    text = re.sub(r"\*([^*]+)\*", r"\1", text)
    text = re.sub(r"\[(.*?)\]\([^)]+\)", r"\1", text)
    text = re.sub(r"\s+", " ", text)
    return text.strip()


def split_sentences(text: str) -> list[str]:
    text = normalize_inline(text)
    if not text:
        return []
    parts = re.split(r"(?<=[.!?])\s+", text)
    return [p.strip() for p in parts if p.strip()]


def extract_section(markdown: str, heading: str) -> str | None:
    lines = markdown.splitlines()
    target = heading.strip().lower()
    capture = False
    level = None
    body: list[str] = []

    for line in lines:
        match = re.match(r"^(#{1,6})\s+(.*)$", line)
        if match:
            current_level = len(match.group(1))
            current_heading = match.group(2).strip().lower()
            if capture and level is not None and current_level <= level:
                break
            if current_heading == target:
                capture = True
                level = current_level
                body = []
                continue
        if capture:
            body.append(line)

    if not capture:
        return None
    return "\n".join(body).strip()


def summarize_paragraph_section(section: str, sentence_limit: int = 2) -> str | None:
    paragraphs = [
        normalize_inline(chunk)
        for chunk in re.split(r"\n\s*\n", section)
        if chunk.strip() and not chunk.lstrip().startswith(("-", "|", "```"))
    ]
    for paragraph in paragraphs:
        sentences = split_sentences(paragraph)
        if sentences:
            return " ".join(sentences[:sentence_limit]).strip()
    return None


def summarize_list_section(section: str, item_limit: int = 3) -> str | None:
    items: list[str] = []
    for raw_line in section.splitlines():
        line = raw_line.strip()
        if not line:
            continue
        if line.startswith("- "):
            items.append(normalize_inline(line[2:]))
        elif re.match(r"^\d+\.\s+", line):
            items.append(normalize_inline(re.sub(r"^\d+\.\s+", "", line)))
        if len(items) >= item_limit:
            break
    if not items:
        return None
    return "; ".join(items)


def find_ai_harness_learnings() -> list[str]:
    if not LEARNINGS_DIR.exists():
        return []

    matches: list[str] = []
    for path in sorted(LEARNINGS_DIR.glob("*.md")):
        text = path.read_text(encoding="utf-8").lower()
        if (
            "project: ai-harness" in text
            or "ai-harness" in text
            or "ai harness" in text
        ):
            matches.append(path.relative_to(VAULT_DIR).as_posix())
    return matches


def git_generated_at(relative_paths: list[str]) -> str:
    if not relative_paths:
        return "unknown"
    try:
        cmd = ["git", "log", "-1", "--format=%cI", "--", *relative_paths]
        result = subprocess.run(
            cmd,
            cwd=HARNESS_ROOT,
            check=True,
            capture_output=True,
            text=True,
        )
        value = result.stdout.strip()
        return value or "unknown"
    except Exception:
        return "unknown"


def format_source_list(paths: list[str]) -> list[str]:
    return [f"- `{rel_path}`" for rel_path in paths]


def build_ai_harness_page(spec: TopicSpec) -> str:
    sources: dict[str, str] = {}
    for rel_path in spec.source_paths:
        content = read_text(rel_path)
        if content:
            sources[rel_path] = content

    learnings = find_ai_harness_learnings()
    generated_from = list(sources.keys()) + learnings

    current_state: list[str] = []
    key_architecture: list[str] = []
    known_gotchas: list[str] = []
    active_decisions: list[str] = []
    open_followups: list[str] = []

    shipped = sources.get("plans/whats-next-2026-04-27.md")
    if shipped:
        section = extract_section(shipped, "What just shipped (one-paragraph recap)")
        summary = summarize_paragraph_section(section or "", sentence_limit=2)
        if summary:
            current_state.append(
                f"{summary} Source: `plans/whats-next-2026-04-27.md`."
            )

        for heading in (
            "A1. Multi-agent chain replay",
            "A2. Validate `harness_handoff` tool path actually works",
            "A3. Cherry-pick template-safe parts to public `main`",
        ):
            subsection = extract_section(shipped, heading)
            summary = summarize_paragraph_section(subsection or "", sentence_limit=1)
            if summary:
                open_followups.append(f"{heading} — {summary}")

    d31 = sources.get("plans/d31-orchestrator-codex-2026-04-29.md")
    if d31:
        section = extract_section(d31, "Current state (2026-04-30 UTC)")
        summary = summarize_list_section(section or "", item_limit=3)
        if summary:
            current_state.append(
                f"{summary}. Source: `plans/d31-orchestrator-codex-2026-04-29.md`."
            )

        risk = extract_section(d31, "Risk assessment")
        if risk:
            known_gotchas.append(
                "Orchestrator changes are high-risk because that role runs in nearly every project channel and it is the only role that emits handoff, parallel, create-channel, and chain-complete directives. Source: `plans/d31-orchestrator-codex-2026-04-29.md`."
            )

        decision = extract_section(d31, "Decision: cost capture first, or D3.1 first?")
        if decision:
            active_decisions.append(
                "The explicit sequencing call is whether to wire accurate Codex cost capture first or accept conservative over-reporting and move directly into the orchestrator-on-Codex migration. Source: `plans/d31-orchestrator-codex-2026-04-29.md`."
            )

    cache_plan = sources.get("plans/context-assembly-cache-2026-04-24.md")
    if cache_plan:
        risk = extract_section(cache_plan, "Critical risk (why this plan is careful)")
        summary = summarize_paragraph_section(risk or "", sentence_limit=2)
        if summary:
            known_gotchas.append(
                f"{summary} Source: `plans/context-assembly-cache-2026-04-24.md`."
            )

        stratified = extract_section(cache_plan, "Stratified cache")
        if stratified:
            key_architecture.append(
                "The context plan splits assembly into three layers: stable system context, prompt-dependent retrieved learnings, and a volatile tail. Only the stable layer is a safe cache target. Source: `plans/context-assembly-cache-2026-04-24.md`."
            )

        design = extract_section(cache_plan, "Design")
        if design:
            key_architecture.append(
                "The design constraint is retrieval correctness: cache reuse must never flatten prompt-specific learning selection into a channel-wide default. Source: `plans/context-assembly-cache-2026-04-24.md`."
            )

    if learnings:
        active_decisions.append(
            f"Project-tagged learnings are available for fallback evidence ({len(learnings)} file(s)); keep the compiled topic page concise and let raw learnings stay secondary in context injection."
        )
    else:
        active_decisions.append(
            "No `vault/learnings/` entries are checked into this worktree for `ai-harness`, so the MVP source of truth is the explicit plan set above plus any runtime-only context supplied outside git."
        )

    frontmatter_lines = [
        "---",
        "id: TOPIC-ai-harness",
        "type: topic",
        "topic: ai-harness",
        "status: active",
        f"generated_at: {git_generated_at(generated_from)}",
        "generated_from: [" + ", ".join(f'\"{path}\"' for path in generated_from) + "]",
        'compressed: "AI Harness is the multi-agent runtime project; the current checked-in synthesis centers on Codex orchestration, deterministic context assembly, and closing the handoff and replay loop."',
        "---",
        "",
    ]

    lines = frontmatter_lines + [
        "# AI Harness",
        "",
        "## Current State",
    ]
    lines.extend(f"- {item}" for item in current_state or [
        "Checked-in topic inputs are missing; regenerate after adding the expected plan and vault sources."
    ])
    lines.extend([
        "",
        "## Key Architecture",
    ])
    lines.extend(f"- {item}" for item in key_architecture or [
        "Context assembly and chain orchestration sources are not available in this checkout."
    ])
    lines.extend([
        "",
        "## Known Gotchas",
    ])
    lines.extend(f"- {item}" for item in known_gotchas or [
        "No checked-in gotcha sources matched this topic."
    ])
    lines.extend([
        "",
        "## Active Decisions",
    ])
    lines.extend(f"- {item}" for item in active_decisions)
    lines.extend([
        "",
        "## Open Follow-ups",
    ])
    lines.extend(f"- {item}" for item in open_followups or [
        "No checked-in follow-up sections matched this topic."
    ])
    lines.extend([
        "",
        "## Sources",
    ])
    lines.extend(format_source_list(generated_from or list(spec.source_paths)))
    lines.append("")

    return "\n".join(lines)


def build_topic(topic: str) -> str:
    spec = TOPICS.get(topic)
    if spec is None:
        raise SystemExit(f"Unknown topic: {topic}")
    if spec.slug == "ai-harness":
        return build_ai_harness_page(spec)
    raise SystemExit(f"No compiler implemented for topic: {topic}")


def write_topic(topic: str, content: str, check: bool) -> bool:
    spec = TOPICS[topic]
    spec.output_path.parent.mkdir(parents=True, exist_ok=True)

    if check:
        if not spec.output_path.exists():
            print(f"Missing generated file: {spec.output_path}", file=sys.stderr)
            return False
        existing = spec.output_path.read_text(encoding="utf-8")
        if existing != content:
            print(f"Out of date: {spec.output_path}", file=sys.stderr)
            return False
        return True

    spec.output_path.write_text(content, encoding="utf-8")
    print(f"Wrote {spec.output_path.relative_to(HARNESS_ROOT)}")
    return True


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--topic",
        action="append",
        dest="topics",
        help="Topic slug to rebuild. Defaults to all supported topics.",
    )
    parser.add_argument(
        "--check",
        action="store_true",
        help="Exit non-zero if generated files are missing or stale.",
    )
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    topics = args.topics or sorted(TOPICS.keys())
    ok = True
    for topic in topics:
        content = build_topic(topic)
        ok = write_topic(topic, content, args.check) and ok
    return 0 if ok else 1


if __name__ == "__main__":
    raise SystemExit(main())
