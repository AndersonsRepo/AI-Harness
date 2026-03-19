"""Cross-platform abstractions for paths, processes, signals, environment, and scheduling.

Phases W1+W2 of cross-platform plan.
Every platform-specific operation funnels through this module so the rest
of the codebase stays platform-agnostic.

Usage:
    from lib.platform import paths, proc, env, scheduler

    paths.python()          # "/opt/homebrew/bin/python3" or "python" on Windows
    paths.claude_cli()      # "~/.local/bin/claude" or "%LOCALAPPDATA%\\claude\\claude.exe"
    paths.home()            # HOME or USERPROFILE
    paths.temp_dir()        # /tmp or %TEMP%
    proc.is_alive(pid)      # signal-0 on Unix, OpenProcess on Windows
    proc.terminate(pid)     # SIGTERM on Unix, taskkill on Windows
    env.clean_path()        # colon-separated on Unix, semicolon on Windows
    scheduler.install(...)  # launchd plist on macOS, schtasks on Windows
    scheduler.status(...)   # launchctl list on macOS, schtasks /Query on Windows
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


# ─── Scheduler Abstraction ───────────────────────────────────────────

import json as _json
import re as _re
from dataclasses import dataclass


@dataclass
class TaskStatus:
    """Cross-platform scheduled task status."""
    label: str
    loaded: bool
    pid: int | None = None
    exit_code: int | None = None
    state: str = "unknown"  # "running", "loaded", "not-loaded", "stale"


def _parse_schedule_to_seconds(schedule: str) -> int:
    """Parse schedule string like '30m', '2h' to seconds."""
    m = _re.match(r"^(\d+)(m|h)$", schedule.strip())
    if not m:
        raise ValueError(f"Invalid schedule format: {schedule}")
    value, unit = int(m.group(1)), m.group(2)
    return value * 60 if unit == "m" else value * 3600


def _expand_cron_field(s: str) -> list[int]:
    """Expand cron field like '1-5' to [1,2,3,4,5]."""
    if s == "*":
        return []
    if s.startswith("*/"):
        return []  # Step values — not directly representable in all schedulers
    parts = []
    for segment in s.split(","):
        if "-" in segment:
            start, end = segment.split("-", 1)
            parts.extend(range(int(start), int(end) + 1))
        else:
            parts.append(int(segment))
    return parts


def _cron_to_calendar_intervals(cron_expr: str) -> list[dict]:
    """Convert 5-field cron expression to launchd-style interval dicts."""
    fields = cron_expr.strip().split()
    if len(fields) != 5:
        raise ValueError(f"Cron expression must have 5 fields: '{cron_expr}'")

    minutes = _expand_cron_field(fields[0])
    hours = _expand_cron_field(fields[1])
    doms = _expand_cron_field(fields[2])
    months = _expand_cron_field(fields[3])
    dows = _expand_cron_field(fields[4])

    base: dict = {}
    if len(minutes) == 1:
        base["Minute"] = minutes[0]
    if len(hours) == 1:
        base["Hour"] = hours[0]
    if len(doms) == 1:
        base["Day"] = doms[0]
    if len(months) == 1:
        base["Month"] = months[0]

    if len(dows) > 1:
        return [{**base, "Weekday": dow} for dow in dows]
    elif len(dows) == 1:
        base["Weekday"] = dows[0]

    if len(minutes) > 1:
        return [{**base, "Minute": m} for m in minutes]
    if len(hours) > 1:
        return [{**base, "Hour": h} for h in hours]

    return [base] if base else [{}]


def _dict_to_plist_xml(d: dict, indent: int = 2) -> str:
    """Convert a dict to plist XML dict entries."""
    pad = "    " * indent
    lines = []
    for key, value in d.items():
        lines.append(f"{pad}<key>{key}</key>")
        lines.append(f"{pad}<integer>{value}</integer>")
    return "\n".join(lines)


class _Scheduler:
    """Cross-platform scheduled task management.

    macOS: launchd plists in ~/Library/LaunchAgents/
    Windows: Windows Task Scheduler via schtasks.exe
    Linux: systemd user timers (future)
    """

    LABEL_PREFIX = "com.aiharness.heartbeat"

    def name(self) -> str:
        """Name of the platform scheduler."""
        if IS_MACOS:
            return "launchd"
        if IS_WINDOWS:
            return "task-scheduler"
        return "systemd"

    def is_available(self) -> bool:
        """Check if the scheduler is usable."""
        if IS_MACOS:
            return shutil.which("launchctl") is not None
        if IS_WINDOWS:
            return shutil.which("schtasks") is not None
        return shutil.which("systemctl") is not None

    def task_label(self, task_name: str) -> str:
        """Full label for a task (e.g. com.aiharness.heartbeat.health-check)."""
        return f"{self.LABEL_PREFIX}.{task_name}"

    # ── Install / Uninstall ──────────────────────────────────────────

    def install(
        self,
        task_name: str,
        config: dict,
        harness_root: str | None = None,
    ) -> str:
        """Install a scheduled task from config. Returns the installed path/label."""
        if IS_MACOS:
            return self._install_launchd(task_name, config, harness_root)
        if IS_WINDOWS:
            return self._install_schtasks(task_name, config, harness_root)
        raise NotImplementedError(f"Scheduler install not implemented for {platform.system()}")

    def uninstall(self, task_name: str) -> bool:
        """Remove a scheduled task. Returns True on success."""
        label = self.task_label(task_name)
        if IS_MACOS:
            return self._uninstall_launchd(label)
        if IS_WINDOWS:
            return self._uninstall_schtasks(label)
        raise NotImplementedError(f"Scheduler uninstall not implemented for {platform.system()}")

    def generate_config(self, task_name: str, config: dict, harness_root: str | None = None) -> str:
        """Generate scheduler config content without installing. Returns the content string."""
        if IS_MACOS:
            return self._generate_plist(task_name, config, harness_root)
        if IS_WINDOWS:
            return self._generate_schtasks_xml(task_name, config, harness_root)
        raise NotImplementedError(f"Config generation not implemented for {platform.system()}")

    # ── Status / List ────────────────────────────────────────────────

    def status(self, label: str) -> TaskStatus:
        """Get status of a specific scheduled task."""
        if IS_MACOS:
            return self._status_launchd(label)
        if IS_WINDOWS:
            return self._status_schtasks(label)
        return TaskStatus(label=label, loaded=False, state="unsupported")

    def list_tasks(self, prefix: str | None = None) -> list[TaskStatus]:
        """List all scheduled tasks matching prefix."""
        prefix = prefix or self.LABEL_PREFIX
        if IS_MACOS:
            return self._list_launchd(prefix)
        if IS_WINDOWS:
            return self._list_schtasks(prefix)
        return []

    # ── Control ──────────────────────────────────────────────────────

    def reload(self, label_or_name: str) -> bool:
        """Stop and restart a scheduled task. Returns True on success."""
        label = label_or_name if "." in label_or_name else self.task_label(label_or_name)
        if IS_MACOS:
            return self._reload_launchd(label)
        if IS_WINDOWS:
            return self._reload_schtasks(label)
        return False

    def kickstart(self, label_or_name: str) -> bool:
        """Force-run a task immediately. Returns True on success."""
        label = label_or_name if "." in label_or_name else self.task_label(label_or_name)
        if IS_MACOS:
            return self._kickstart_launchd(label)
        if IS_WINDOWS:
            return self._kickstart_schtasks(label)
        return False

    def reload_stale(self) -> list[str]:
        """Detect and reload stale tasks (e.g. exit code 78 on macOS). Returns names reloaded."""
        if IS_MACOS:
            return self._reload_stale_launchd()
        return []  # Windows Task Scheduler doesn't have this failure mode

    # ── macOS launchd implementation ─────────────────────────────────

    def _plist_path(self, label: str) -> str:
        launch_dir = paths.launch_agents_dir()
        if not launch_dir:
            raise RuntimeError("LaunchAgents directory not found")
        return os.path.join(launch_dir, f"{label}.plist")

    def _generate_plist(self, task_name: str, config: dict, harness_root: str | None = None) -> str:
        """Generate launchd plist XML."""
        home = paths.home()
        harness_symlink = os.path.join(home, ".local", "ai-harness")
        label = self.task_label(task_name)
        log_path = f"{harness_symlink}/heartbeat-tasks/logs/{task_name}.log"
        python_path = paths.python()

        # Determine scheduling
        cron_expr = config.get("cron")
        schedule = config.get("schedule")
        interval_minutes = config.get("interval_minutes")

        if not schedule and interval_minutes:
            mins = int(interval_minutes)
            schedule = f"{mins // 60}h" if mins >= 60 and mins % 60 == 0 else f"{mins}m"

        if cron_expr:
            intervals = _cron_to_calendar_intervals(cron_expr)
            if len(intervals) == 1:
                schedule_xml = f"""    <key>StartCalendarInterval</key>
    <dict>
{_dict_to_plist_xml(intervals[0])}
    </dict>"""
            else:
                entries = []
                for interval in intervals:
                    entries.append(f"        <dict>\n{_dict_to_plist_xml(interval, 3)}\n        </dict>")
                schedule_xml = f"""    <key>StartCalendarInterval</key>
    <array>
{chr(10).join(entries)}
    </array>"""
        elif schedule:
            seconds = _parse_schedule_to_seconds(schedule)
            schedule_xml = f"""    <key>StartInterval</key>
    <integer>{seconds}</integer>"""
        else:
            raise ValueError(f"Task {task_name} has neither 'schedule' nor 'cron' field")

        return f"""<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>{label}</string>

    <key>ProgramArguments</key>
    <array>
        <string>{python_path}</string>
        <string>{harness_symlink}/heartbeat-tasks/heartbeat-runner.py</string>
        <string>{task_name}</string>
    </array>

    <key>WorkingDirectory</key>
    <string>{harness_symlink}</string>

    <key>EnvironmentVariables</key>
    <dict>
        <key>PATH</key>
        <string>{home}/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin</string>
        <key>HOME</key>
        <string>{home}</string>
    </dict>

{schedule_xml}

    <key>RunAtLoad</key>
    <false/>

    <key>StandardOutPath</key>
    <string>{log_path}</string>

    <key>StandardErrorPath</key>
    <string>{log_path}</string>

    <key>ProcessType</key>
    <string>Background</string>
</dict>
</plist>
"""

    def _install_launchd(self, task_name: str, config: dict, harness_root: str | None = None) -> str:
        label = self.task_label(task_name)
        plist_path = self._plist_path(label)
        plist_xml = self._generate_plist(task_name, config, harness_root)

        # Unload if already loaded
        subprocess.run(["launchctl", "unload", plist_path], capture_output=True)
        # Write plist
        os.makedirs(os.path.dirname(plist_path), exist_ok=True)
        with open(plist_path, "w") as f:
            f.write(plist_xml)
        # Load
        result = subprocess.run(["launchctl", "load", plist_path], capture_output=True, text=True)
        if result.returncode != 0:
            raise RuntimeError(f"launchctl load failed: {result.stderr}")
        return plist_path

    def _uninstall_launchd(self, label: str) -> bool:
        plist_path = self._plist_path(label)
        subprocess.run(["launchctl", "unload", plist_path], capture_output=True)
        if os.path.exists(plist_path):
            os.remove(plist_path)
            return True
        return False

    def _status_launchd(self, label: str) -> TaskStatus:
        result = subprocess.run(
            ["launchctl", "list", label],
            capture_output=True, text=True,
        )
        if result.returncode != 0:
            return TaskStatus(label=label, loaded=False, state="not-loaded")

        pid = None
        for line in result.stdout.split("\n"):
            line = line.strip()
            if '"PID"' in line:
                try:
                    pid = int(line.split("=")[1].strip().rstrip(";"))
                except (ValueError, IndexError):
                    pass

        if pid:
            return TaskStatus(label=label, loaded=True, pid=pid, state="running")
        return TaskStatus(label=label, loaded=True, state="loaded")

    def _list_launchd(self, prefix: str) -> list[TaskStatus]:
        try:
            result = subprocess.run(
                ["launchctl", "list"],
                capture_output=True, text=True, timeout=10,
            )
            if result.returncode != 0:
                return []
        except Exception:
            return []

        tasks = []
        for line in result.stdout.strip().split("\n"):
            parts = line.split("\t")
            if len(parts) < 3:
                continue
            pid_str, exit_str, label = parts[0].strip(), parts[1].strip(), parts[2].strip()
            if not label.startswith(prefix):
                continue

            pid = int(pid_str) if pid_str != "-" else None
            exit_code = int(exit_str) if exit_str != "-" else None
            state = "running" if pid else ("stale" if exit_code == 78 else "loaded")
            tasks.append(TaskStatus(
                label=label, loaded=True, pid=pid,
                exit_code=exit_code, state=state,
            ))
        return tasks

    def _reload_launchd(self, label: str) -> bool:
        plist_path = self._plist_path(label)
        if not os.path.exists(plist_path):
            return False
        subprocess.run(["launchctl", "unload", plist_path], capture_output=True, timeout=10)
        result = subprocess.run(
            ["launchctl", "load", plist_path],
            capture_output=True, text=True, timeout=10,
        )
        return result.returncode == 0

    def _kickstart_launchd(self, label: str) -> bool:
        result = subprocess.run(
            ["launchctl", "kickstart", f"gui/{os.getuid()}/{label}"],
            capture_output=True, text=True,
        )
        return result.returncode == 0

    def _reload_stale_launchd(self) -> list[str]:
        """Detect launchd agents with exit code 78 (stale from sleep) and reload them."""
        reloaded = []
        tasks = self._list_launchd(self.LABEL_PREFIX)
        for task in tasks:
            if task.state == "stale":
                name = task.label.replace(f"{self.LABEL_PREFIX}.", "")
                if self._reload_launchd(task.label):
                    reloaded.append(name)
        return reloaded

    # ── Windows Task Scheduler implementation ────────────────────────

    def _schtasks_name(self, label: str) -> str:
        """Convert dotted label to backslash path for schtasks."""
        return f"\\{label.replace('.', '\\')}"

    def _generate_schtasks_xml(self, task_name: str, config: dict, harness_root: str | None = None) -> str:
        """Generate Windows Task Scheduler XML."""
        hr = harness_root or os.environ.get("HARNESS_ROOT", "")
        python_path = paths.python()
        runner = os.path.join(hr, "heartbeat-tasks", "heartbeat-runner.py")
        log_path = os.path.join(hr, "heartbeat-tasks", "logs", f"{task_name}.log")

        cron_expr = config.get("cron")
        schedule = config.get("schedule")
        interval_minutes = config.get("interval_minutes")

        if not schedule and interval_minutes:
            mins = int(interval_minutes)
            schedule = f"{mins // 60}h" if mins >= 60 and mins % 60 == 0 else f"{mins}m"

        # Build trigger XML
        if cron_expr:
            fields = cron_expr.strip().split()
            minute = fields[0] if fields[0] != "*" else "0"
            hour = fields[1] if fields[1] != "*" else "0"
            dows = _expand_cron_field(fields[4])
            dow_names = ["SUN", "MON", "TUE", "WED", "THU", "FRI", "SAT"]
            if dows:
                days_xml = "".join(f"<{dow_names[d]} />" for d in dows)
                trigger_xml = f"""    <CalendarTrigger>
      <StartBoundary>2026-01-01T{int(hour):02d}:{int(minute):02d}:00</StartBoundary>
      <ScheduleByWeek>
        <DaysOfWeek>{days_xml}</DaysOfWeek>
        <WeeksInterval>1</WeeksInterval>
      </ScheduleByWeek>
    </CalendarTrigger>"""
            else:
                trigger_xml = f"""    <CalendarTrigger>
      <StartBoundary>2026-01-01T{int(hour):02d}:{int(minute):02d}:00</StartBoundary>
      <ScheduleByDay>
        <DaysInterval>1</DaysInterval>
      </ScheduleByDay>
    </CalendarTrigger>"""
        elif schedule:
            seconds = _parse_schedule_to_seconds(schedule)
            minutes_interval = max(1, seconds // 60)
            trigger_xml = f"""    <TimeTrigger>
      <StartBoundary>2026-01-01T00:00:00</StartBoundary>
      <Repetition>
        <Interval>PT{minutes_interval}M</Interval>
        <StopAtDurationEnd>false</StopAtDurationEnd>
      </Repetition>
    </TimeTrigger>"""
        else:
            raise ValueError(f"Task {task_name} has neither 'schedule' nor 'cron' field")

        return f"""<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <Triggers>
{trigger_xml}
  </Triggers>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <ExecutionTimeLimit>PT1H</ExecutionTimeLimit>
  </Settings>
  <Actions>
    <Exec>
      <Command>{python_path}</Command>
      <Arguments>{runner} {task_name}</Arguments>
      <WorkingDirectory>{hr}</WorkingDirectory>
    </Exec>
  </Actions>
</Task>
"""

    def _install_schtasks(self, task_name: str, config: dict, harness_root: str | None = None) -> str:
        label = self.task_label(task_name)
        schtask_name = self._schtasks_name(label)
        xml_content = self._generate_schtasks_xml(task_name, config, harness_root)

        # Write XML to temp file
        xml_path = os.path.join(tempfile.gettempdir(), f"{task_name}_task.xml")
        with open(xml_path, "w", encoding="utf-16") as f:
            f.write(xml_content)

        # Delete existing task if any
        subprocess.run(
            ["schtasks", "/Delete", "/TN", schtask_name, "/F"],
            capture_output=True,
        )

        # Create from XML
        result = subprocess.run(
            ["schtasks", "/Create", "/TN", schtask_name, "/XML", xml_path],
            capture_output=True, text=True,
        )
        os.unlink(xml_path)

        if result.returncode != 0:
            raise RuntimeError(f"schtasks create failed: {result.stderr}")
        return schtask_name

    def _uninstall_schtasks(self, label: str) -> bool:
        schtask_name = self._schtasks_name(label)
        result = subprocess.run(
            ["schtasks", "/Delete", "/TN", schtask_name, "/F"],
            capture_output=True,
        )
        return result.returncode == 0

    def _status_schtasks(self, label: str) -> TaskStatus:
        schtask_name = self._schtasks_name(label)
        result = subprocess.run(
            ["schtasks", "/Query", "/TN", schtask_name, "/FO", "CSV", "/V", "/NH"],
            capture_output=True, text=True,
        )
        if result.returncode != 0:
            return TaskStatus(label=label, loaded=False, state="not-loaded")

        # CSV output: HostName,TaskName,NextRunTime,Status,...
        for line in result.stdout.strip().split("\n"):
            fields = line.strip('"').split('","')
            if len(fields) >= 4:
                status_str = fields[3] if len(fields) > 3 else "Unknown"
                state = "running" if status_str == "Running" else "loaded"
                return TaskStatus(label=label, loaded=True, state=state)

        return TaskStatus(label=label, loaded=True, state="loaded")

    def _list_schtasks(self, prefix: str) -> list[TaskStatus]:
        schtask_prefix = self._schtasks_name(prefix)
        result = subprocess.run(
            ["schtasks", "/Query", "/FO", "CSV", "/NH"],
            capture_output=True, text=True,
        )
        if result.returncode != 0:
            return []

        tasks = []
        for line in result.stdout.strip().split("\n"):
            fields = line.strip('"').split('","')
            if len(fields) >= 4:
                name = fields[1] if len(fields) > 1 else ""
                if name.startswith(schtask_prefix):
                    status_str = fields[3] if len(fields) > 3 else "Unknown"
                    state = "running" if status_str == "Running" else "loaded"
                    # Convert backslash name back to dot label
                    label = name.lstrip("\\").replace("\\", ".")
                    tasks.append(TaskStatus(label=label, loaded=True, state=state))
        return tasks

    def _reload_schtasks(self, label: str) -> bool:
        schtask_name = self._schtasks_name(label)
        # Disable then enable
        subprocess.run(["schtasks", "/Change", "/TN", schtask_name, "/DISABLE"], capture_output=True)
        result = subprocess.run(
            ["schtasks", "/Change", "/TN", schtask_name, "/ENABLE"],
            capture_output=True, text=True,
        )
        return result.returncode == 0

    def _kickstart_schtasks(self, label: str) -> bool:
        schtask_name = self._schtasks_name(label)
        result = subprocess.run(
            ["schtasks", "/Run", "/TN", schtask_name],
            capture_output=True, text=True,
        )
        return result.returncode == 0


# ─── Module-level singletons ──────────────────────────────────────────

paths = _Paths()
proc = _Proc()
env = _Env()
scheduler = _Scheduler()
