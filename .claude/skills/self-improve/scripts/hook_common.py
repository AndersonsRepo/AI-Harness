"""Shared helpers for self-improve hook scripts."""

from __future__ import annotations

import os
from pathlib import Path
from typing import Any


def resolve_harness_root(script_dir: Path) -> Path:
    """Resolve the harness checkout from the hook script location, with env override."""
    override = os.environ.get("HARNESS_ROOT")
    if override:
        return Path(override).expanduser().resolve()

    current = Path(script_dir).resolve()
    for candidate in (current, *current.parents):
        if (
            (candidate / ".claude" / "skills" / "self-improve" / "scripts").is_dir()
            and (candidate / "vault").is_dir()
        ):
            return candidate

    # scripts/ -> self-improve/ -> skills/ -> .claude/ -> repo
    return current.parents[3]


def get_value(payload: dict[str, Any], *paths: tuple[str, ...]) -> Any:
    """Return the first present nested value for the given key paths."""
    for path in paths:
        value: Any = payload
        for key in path:
            if not isinstance(value, dict) or key not in value:
                value = None
                break
            value = value[key]
        if value not in (None, ""):
            return value
    return None


def coerce_name(value: Any) -> str:
    """Extract a readable identity from string or object payload values."""
    if isinstance(value, str):
        return value.strip()
    if isinstance(value, dict):
        nested = get_value(
            value,
            ("name",),
            ("display_name",),
            ("displayName",),
            ("teammate_name",),
            ("agent_name",),
            ("assignee", "name"),
            ("teammate", "name"),
            ("agent", "name"),
            ("id",),
        )
        if nested is not None:
            return coerce_name(nested)
    return ""


def payload_shape(payload: Any) -> str:
    """Return a compact payload shape for unresolved hook diagnostics."""
    if not isinstance(payload, dict):
        return type(payload).__name__
    parts: list[str] = []
    for key, value in payload.items():
        if isinstance(value, dict):
            parts.append(f"{key}{{{','.join(value.keys())}}}")
        else:
            parts.append(key)
    return ", ".join(parts) or "empty"
