"""Cross-platform abstractions for paths, processes, signals, and environment.

Phase W1 of cross-platform plan.
Every platform-specific operation funnels through this module so the rest
of the codebase stays platform-agnostic.

Usage:
    from lib.platform import paths, proc, env

    paths.python()          # "/opt/homebrew/bin/python3" or "python" on Windows
    paths.claude_cli()      # "~/.local/bin/claude" or "%LOCALAPPDATA%\\claude\\claude.exe"
    paths.home()            # HOME or USERPROFILE
    paths.temp_dir()        # /tmp or %TEMP%
    proc.is_alive(pid)      # signal-0 on Unix, OpenProcess on Windows
    proc.terminate(pid)     # SIGTERM on Unix, taskkill on Windows
    env.clean_path()        # colon-separated on Unix, semicolon on Windows
"""

from __future__ import annotations

import os
import platform
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

IS_WINDOWS = platform.system() == "Windows"
IS_MACOS = platform.system() == "Darwin"
IS_LINUX = platform.system() == "Linux"


# ─── Paths ─────────────────────────────────────────────────────────────

class _Paths:
    """Platform-aware path resolution."""

    def home(self) -> str:
        """User home directory."""
        return os.environ.get("HOME") or os.environ.get("USERPROFILE") or str(Path.home())

    def python(self) -> str:
        """Path to Python 3 interpreter."""
        # Explicit env override
        configured = os.environ.get("PYTHON_PATH")
        if configured:
            return configured

        if IS_MACOS:
            # Homebrew default
            brew_python = "/opt/homebrew/bin/python3"
            if os.path.isfile(brew_python):
                return brew_python

        # Fallback: find python3 (or python on Windows) in PATH
        name = "python" if IS_WINDOWS else "python3"
        found = shutil.which(name)
        if found:
            return found

        # Windows fallback: try python3 too
        if IS_WINDOWS:
            found = shutil.which("python3")
            if found:
                return found

        return name  # last resort — hope it's in PATH

    def claude_cli(self) -> str:
        """Path to Claude CLI binary."""
        configured = os.environ.get("CLAUDE_CLI_PATH")
        if configured:
            return configured

        if IS_WINDOWS:
            # Windows: check common install locations
            local_app = os.environ.get("LOCALAPPDATA", "")
            candidates = [
                os.path.join(local_app, "claude", "claude.exe"),
                os.path.join(local_app, "Programs", "claude", "claude.exe"),
            ]
            for c in candidates:
                if os.path.isfile(c):
                    return c
            # Fallback to PATH
            found = shutil.which("claude")
            return found or "claude"

        # Unix: ~/.local/bin/claude
        return os.path.join(self.home(), ".local", "bin", "claude")

    def temp_dir(self) -> str:
        """Platform temp directory."""
        return tempfile.gettempdir()

    def path_separator(self) -> str:
        """PATH environment variable separator (: on Unix, ; on Windows)."""
        return ";" if IS_WINDOWS else ":"

    def build_path(self, *dirs: str) -> str:
        """Build a PATH string from directory components."""
        return self.path_separator().join(d for d in dirs if d)

    def default_path(self) -> str:
        """Reasonable default PATH for clean subprocess environments."""
        home = self.home()
        if IS_WINDOWS:
            system_root = os.environ.get("SystemRoot", r"C:\Windows")
            return self.build_path(
                os.path.join(home, ".local", "bin"),
                os.path.join(system_root, "System32"),
                system_root,
            )
        # macOS/Linux
        return self.build_path(
            os.path.join(home, ".local", "bin"),
            "/opt/homebrew/bin",
            "/usr/local/bin",
            "/usr/bin",
            "/bin",
        )

    def default_shell(self) -> str:
        """Default shell for the platform."""
        if IS_WINDOWS:
            return os.environ.get("COMSPEC", r"C:\Windows\System32\cmd.exe")
        return os.environ.get("SHELL", "/bin/zsh")

    def google_drive_dir(self) -> str | None:
        """Auto-detect Google Drive mount point. Returns None if not found."""
        if IS_MACOS:
            cloud_dir = os.path.expanduser("~/Library/CloudStorage")
            if os.path.isdir(cloud_dir):
                for entry in os.listdir(cloud_dir):
                    if entry.startswith("GoogleDrive-"):
                        return os.path.join(cloud_dir, entry, "My Drive")
            return None

        if IS_WINDOWS:
            # Google Drive for Desktop creates a virtual drive (G:\) or
            # streams to %USERPROFILE%\Google Drive
            candidates = [
                os.path.join(self.home(), "Google Drive"),
                os.path.join(self.home(), "My Drive"),
            ]
            # Also check drive letters G: through Z:
            for letter in "GHIJKLMNOPQRSTUVWXYZ":
                candidates.append(f"{letter}:\\My Drive")
            for c in candidates:
                if os.path.isdir(c):
                    return c
            return None

        # Linux: common locations
        for candidate in [
            os.path.expanduser("~/google-drive"),
            os.path.expanduser("~/Google Drive"),
        ]:
            if os.path.isdir(candidate):
                return candidate
        return None

    def launch_agents_dir(self) -> str | None:
        """macOS LaunchAgents directory. None on other platforms."""
        if IS_MACOS:
            return os.path.join(self.home(), "Library", "LaunchAgents")
        return None


# ─── Process Management ────────────────────────────────────────────────

class _Proc:
    """Cross-platform process management."""

    def is_alive(self, pid: int) -> bool:
        """Check if a process is running."""
        if IS_WINDOWS:
            try:
                result = subprocess.run(
                    ["tasklist", "/FI", f"PID eq {pid}", "/NH"],
                    capture_output=True, text=True, timeout=5,
                )
                return str(pid) in result.stdout
            except Exception:
                return False
        else:
            # Unix: signal 0 checks existence without affecting the process
            try:
                os.kill(pid, 0)
                return True
            except (OSError, ProcessLookupError):
                return False

    def terminate(self, pid: int) -> bool:
        """Terminate a process gracefully. Returns True if signal was sent."""
        if IS_WINDOWS:
            try:
                subprocess.run(
                    ["taskkill", "/PID", str(pid), "/F"],
                    capture_output=True, timeout=10,
                )
                return True
            except Exception:
                return False
        else:
            try:
                os.kill(pid, 15)  # SIGTERM
                return True
            except (OSError, ProcessLookupError):
                return False

    def open_url(self, url: str) -> None:
        """Open a URL in the default browser."""
        import webbrowser
        webbrowser.open(url)


# ─── Environment ───────────────────────────────────────────────────────

class _Env:
    """Cross-platform environment utilities."""

    def clean_env(self, *, passthrough: list[str] | None = None) -> dict[str, str]:
        """Build a clean subprocess environment.

        Strips CLAUDE* vars (nested session prevention), sets sensible defaults.
        Optional passthrough list for integration-specific vars.
        """
        home = paths.home()
        result = {
            "HOME": home,
            "USERPROFILE": home,  # Windows compat
            "USER": os.environ.get("USER", os.environ.get("USERNAME", "")),
            "PATH": paths.default_path(),
            "SHELL": paths.default_shell(),
            "LANG": os.environ.get("LANG", "en_US.UTF-8"),
            "TERM": "dumb",
            "HARNESS_ROOT": os.environ.get("HARNESS_ROOT", ""),
        }

        if IS_WINDOWS:
            # Windows needs these for subprocess spawning
            for var in ("SystemRoot", "COMSPEC", "TEMP", "TMP", "LOCALAPPDATA", "APPDATA"):
                val = os.environ.get(var)
                if val:
                    result[var] = val

        if passthrough:
            for var in passthrough:
                val = os.environ.get(var)
                if val:
                    result[var] = val

        # Remove empty values
        return {k: v for k, v in result.items() if v}

    def strip_claude_vars(self, base_env: dict[str, str] | None = None) -> dict[str, str]:
        """Return env dict with all CLAUDE* vars removed."""
        source = base_env if base_env is not None else dict(os.environ)
        return {k: v for k, v in source.items() if not k.startswith("CLAUDE")}


# ─── Scheduler Detection ──────────────────────────────────────────────

class _Scheduler:
    """Detect and report the platform scheduler."""

    def name(self) -> str:
        """Name of the platform scheduler."""
        if IS_MACOS:
            return "launchd"
        if IS_WINDOWS:
            return "task-scheduler"
        return "systemd"  # Linux default assumption

    def is_available(self) -> bool:
        """Check if the scheduler is usable."""
        if IS_MACOS:
            return shutil.which("launchctl") is not None
        if IS_WINDOWS:
            return shutil.which("schtasks") is not None
        return shutil.which("systemctl") is not None


# ─── Module-level singletons ──────────────────────────────────────────

paths = _Paths()
proc = _Proc()
env = _Env()
scheduler = _Scheduler()
