#!/usr/bin/env python3
"""Extract text-only conversation digest from a Claude CLI session transcript.

Strips image content (which causes dimension-limit errors) and produces a
clean markdown digest that can be summarized or pasted into a fresh session.

Usage:
    extract-session.py                            # Current session (most-recent .jsonl in cwd's project dir)
    extract-session.py <session-id-or-channel-id> [output-path]
    extract-session.py --list                     # List recent sessions with sizes

If output-path is omitted, writes to vault/shared/<session-id>-digest.md.

Session resolution order with no identifier:
  1. Most recently modified .jsonl across the cwd's project dir AND its ancestors'
     project dirs (so running from a subdir like bridges/discord still resolves to
     the active session, which is the one being written and wins by mtime).
  2. (Nothing — DB sessions are bot-spawned, not the terminal session you're in)
"""
import argparse
import json
import os
import sqlite3
import sys
from pathlib import Path

HARNESS_ROOT = Path(os.environ.get(
    "HARNESS_ROOT",
    Path(__file__).resolve().parent.parent.parent
))
DB_PATH = HARNESS_ROOT / "bridges" / "discord" / "harness.db"
VAULT_SHARED = HARNESS_ROOT / "vault" / "shared"
CLAUDE_PROJECTS = Path.home() / ".claude" / "projects"


def extract_text(content):
    """Pull text from content. Skips image blocks (the poison)."""
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        parts = []
        for block in content:
            if not isinstance(block, dict):
                continue
            btype = block.get("type", "")
            if btype == "text":
                parts.append(block.get("text", ""))
            elif btype == "tool_use":
                parts.append(f"[tool:{block.get('name', '?')}]")
            elif btype == "tool_result":
                result = block.get("content", "")
                if isinstance(result, list):
                    result = " ".join(
                        b.get("text", "") for b in result
                        if isinstance(b, dict) and b.get("type") == "text"
                    )
                parts.append(f"[tool_result] {str(result)[:200]}")
        return "\n".join(p for p in parts if p)
    if isinstance(content, dict):
        return extract_text(content.get("content", ""))
    return ""


def find_transcript(session_id: str) -> Path | None:
    """Locate a session transcript across all Claude project dirs."""
    if not CLAUDE_PROJECTS.exists():
        return None
    matches = list(CLAUDE_PROJECTS.rglob(f"{session_id}.jsonl"))
    return matches[0] if matches else None


def candidate_project_dirs() -> list[Path]:
    """Project dirs for the cwd AND its ancestors (up to $HOME), cwd-first.

    Claude Code slugifies the cwd by replacing '/' with '-' (leading '-' since
    absolute paths start with '/'): /Users/foo/Bar -> -Users-foo-Bar. It creates
    a SEPARATE project dir per cwd, so running from a subdir (e.g. bridges/discord)
    stores transcripts under a different slug than the repo root. Walking ancestors
    keeps resolution scoped to the current project tree while tolerating subdir
    cwds — the active session wins by mtime regardless of which dir holds it.
    """
    if not CLAUDE_PROJECTS.exists():
        return []
    home = Path.home().resolve()
    root = HARNESS_ROOT.resolve()
    dirs: list[Path] = []
    cwd = Path.cwd().resolve()
    for d in [cwd, *cwd.parents]:
        slug = str(d).replace("/", "-")
        candidate = CLAUDE_PROJECTS / slug
        if candidate.is_dir():
            dirs.append(candidate)
        # Stop at the project root (or $HOME as a fallback) so we never walk up
        # into ~/Desktop or ~ and pull in unrelated projects' sessions.
        if d == root or d == home:
            break
    return dirs


def current_session_transcript() -> Path | None:
    """Most recently modified .jsonl across the cwd's project dir and its
    ancestors' — the session actively being written. Robust to running from a
    subdirectory of the project root (the historical wrong-session bug)."""
    jsonls: list[Path] = []
    for proj in candidate_project_dirs():
        jsonls.extend(proj.glob("*.jsonl"))
    if not jsonls:
        return None
    return max(jsonls, key=lambda p: p.stat().st_mtime)


def resolve_channel(channel_ref: str) -> tuple[str, str] | None:
    """Resolve a channel ID or partial match to (channel_id, session_id)."""
    if not DB_PATH.exists():
        return None
    conn = sqlite3.connect(DB_PATH, timeout=5)
    try:
        # Try exact channel_id first, then LIKE match (handles compound keys)
        row = conn.execute(
            "SELECT channel_id, session_id FROM sessions "
            "WHERE channel_id = ? OR channel_id LIKE ? "
            "ORDER BY last_used DESC LIMIT 1",
            (channel_ref, f"{channel_ref}%")
        ).fetchone()
        return row if row else None
    finally:
        conn.close()


def list_recent(limit: int = 10):
    """List recent sessions with transcript sizes.

    Shows current-project Claude Code transcripts first (the terminal sessions
    you're actually in), then DB-tracked bot sessions.
    """
    cand_dirs = candidate_project_dirs()
    proj_jsonls: list[Path] = []
    for d in cand_dirs:
        proj_jsonls.extend(d.glob("*.jsonl"))
    proj_jsonls = sorted(proj_jsonls, key=lambda p: p.stat().st_mtime, reverse=True)[:limit]
    if proj_jsonls:
        print("Current project sessions (terminal — handoff with NO args targets the newest):")
        print(f"{'SESSION':<40} {'SIZE':<10} {'MODIFIED'}")
        print("-" * 80)
        from datetime import datetime
        for p in proj_jsonls:
            st = p.stat()
            mtime = datetime.fromtimestamp(st.st_mtime).strftime("%Y-%m-%d %H:%M:%S")
            size = f"{st.st_size / 1024:.1f}KB"
            print(f"{p.stem:<40} {size:<10} {mtime}")
        print()

    if not DB_PATH.exists():
        return
    conn = sqlite3.connect(DB_PATH, timeout=5)
    try:
        rows = conn.execute(
            "SELECT channel_id, session_id, last_used FROM sessions "
            "ORDER BY last_used DESC LIMIT ?",
            (limit,)
        ).fetchall()
    finally:
        conn.close()

    if rows:
        print("Bot sessions (Discord channels):")
        print(f"{'CHANNEL':<25} {'SESSION':<40} {'SIZE':<10} {'LAST USED'}")
        print("-" * 100)
        for channel_id, session_id, last_used in rows:
            transcript = find_transcript(session_id)
            size = f"{transcript.stat().st_size / 1024:.1f}KB" if transcript else "missing"
            print(f"{channel_id:<25} {session_id:<40} {size:<10} {last_used}")


def build_digest(transcript_path: Path) -> tuple[str, int]:
    """Build text-only digest. Returns (digest_markdown, turn_count)."""
    turns = []
    with transcript_path.open() as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                entry = json.loads(line)
            except json.JSONDecodeError:
                continue

            msg = entry.get("message") or entry
            role = msg.get("role") or entry.get("type", "")
            content = msg.get("content", "")

            if role not in ("user", "assistant"):
                continue

            text = extract_text(content).strip()
            if not text:
                continue

            turns.append((role, text))

    lines = [
        f"# Conversation Digest",
        f"",
        f"Source: {transcript_path.name}",
        f"Total turns: {len(turns)}",
        f"",
        f"---",
        f"",
    ]

    for role, text in turns:
        if len(text) > 2000:
            text = text[:2000] + "\n…[truncated]"
        lines.append(f"## {role.upper()}")
        lines.append("")
        lines.append(text)
        lines.append("")

    return "\n".join(lines), len(turns)


def main():
    parser = argparse.ArgumentParser(description="Extract Claude session digest")
    parser.add_argument("identifier", nargs="?", help="Session UUID or channel ID")
    parser.add_argument("output", nargs="?", help="Output path (optional)")
    parser.add_argument("--list", action="store_true", help="List recent sessions")
    args = parser.parse_args()

    if args.list:
        list_recent()
        return

    ident = args.identifier
    session_id = None
    channel_id = None
    transcript = None

    if not ident:
        # Default: most recently modified .jsonl in the cwd's project dir —
        # the actual terminal session this command was invoked from. The DB
        # only tracks bot-spawned sessions, which are not the current one.
        transcript = current_session_transcript()
        if not transcript:
            print("No current-project Claude Code transcript found.")
            print("Pass a session UUID or channel ID explicitly, or run --list.")
            sys.exit(1)
        session_id = transcript.stem
        print(f"Using current session: {session_id} ({transcript.stat().st_size / 1024:.1f}KB)")
    elif "-" in ident and len(ident) > 20:
        session_id = ident
    else:
        resolved = resolve_channel(ident)
        if not resolved:
            print(f"No session found for channel: {ident}")
            sys.exit(1)
        channel_id, session_id = resolved
        print(f"Resolved channel {channel_id} → session {session_id}")

    if transcript is None:
        transcript = find_transcript(session_id)
    if not transcript:
        print(f"No transcript file found for session {session_id}")
        sys.exit(1)

    print(f"Reading {transcript} ({transcript.stat().st_size / 1024:.1f}KB)")
    digest, turn_count = build_digest(transcript)

    # Default output path
    if args.output:
        out_path = Path(args.output)
    else:
        VAULT_SHARED.mkdir(parents=True, exist_ok=True)
        label = channel_id or session_id[:8]
        out_path = VAULT_SHARED / f"{label}-digest.md"

    out_path.write_text(digest)
    print(f"Wrote {len(digest)} chars, {turn_count} turns to {out_path}")


if __name__ == "__main__":
    main()
