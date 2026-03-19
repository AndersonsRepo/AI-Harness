#!/usr/bin/env python3
"""Repo security/hygiene scanner for registered projects.

Checks for: secrets in code, debug artifacts, committed .env files,
large tracked files, npm audit vulnerabilities, TODOs/FIXMEs, and
Dependabot alerts. Notifies Discord only for NEW critical/high findings.

Usage:
    python3 repo-scanner.py                       # Scan all projects
    python3 repo-scanner.py --project my-project   # Scan one project
    python3 repo-scanner.py --json                 # JSON output (for MCP tool)
    python3 repo-scanner.py --checks secrets,env   # Run specific checks only
"""

import subprocess
import json
import os
import sys
import re
import hashlib
import argparse
import datetime
import shutil

HARNESS_ROOT = os.environ.get(
    "HARNESS_ROOT",
    os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
)
TASKS_DIR = os.path.join(HARNESS_ROOT, "heartbeat-tasks")
PROJECTS_FILE = os.path.join(TASKS_DIR, "projects.json")
STATE_FILE = os.path.join(TASKS_DIR, "repo-scanner.state.json")
NOTIFY_FILE = os.path.join(TASKS_DIR, "pending-notifications.jsonl")
VAULT_DIR = os.path.join(HARNESS_ROOT, "vault")
SCOUTED_DIR = os.path.join(VAULT_DIR, "shared", "scouted")
GH_PATH = os.environ.get("GH_PATH", shutil.which("gh") or "gh")

# ─── Secret Patterns ─────────────────────────────────────────────────

SECRET_PATTERNS = [
    (r'AKIA[0-9A-Z]{16}', "AWS Access Key"),
    (r'(?:sk-|sk_live_|sk_test_)[a-zA-Z0-9]{20,}', "API Secret Key (OpenAI/Stripe)"),
    (r'ghp_[a-zA-Z0-9]{36}', "GitHub Personal Access Token"),
    (r'gho_[a-zA-Z0-9]{36}', "GitHub OAuth Token"),
    (r'ghs_[a-zA-Z0-9]{36}', "GitHub Server Token"),
    (r'xox[bpsorta]-[a-zA-Z0-9-]{10,}', "Slack Token"),
    (r'-----BEGIN (?:RSA |EC |DSA )?PRIVATE KEY-----', "Private Key"),
    (r'(?:mongodb(?:\+srv)?|postgres(?:ql)?|mysql|redis)://[^\s"\']+', "Database Connection String"),
    (r'Bearer\s+[a-zA-Z0-9\-._~+/]+=*', "Bearer Token"),
    (r'eyJ[a-zA-Z0-9_-]*\.eyJ[a-zA-Z0-9_-]*\.[a-zA-Z0-9_-]*', "JWT Token"),
]

COMPILED_SECRETS = [(re.compile(p), desc) for p, desc in SECRET_PATTERNS]

# ─── Helpers ──────────────────────────────────────────────────────────

def resolve_path(p):
    return p.replace("$HOME", os.environ.get("HOME", "")).replace("$HARNESS_ROOT", HARNESS_ROOT)


def load_projects():
    if not os.path.exists(PROJECTS_FILE):
        return {}
    with open(PROJECTS_FILE) as f:
        data = json.load(f)
    return data.get("projects", {})


def load_state():
    if os.path.exists(STATE_FILE):
        with open(STATE_FILE) as f:
            return json.load(f)
    return {}


def save_state(state):
    tmp = STATE_FILE + ".tmp"
    with open(tmp, "w") as f:
        json.dump(state, f, indent=2)
    os.rename(tmp, STATE_FILE)


def finding_hash(check, file_path, line, message):
    h = hashlib.sha256(f"{check}:{file_path}:{line}:{message}".encode()).hexdigest()[:16]
    return h


def notify(channel, message, project_name):
    notification = {
        "task": "repo-scanner",
        "channel": channel,
        "summary": message,
        "timestamp": datetime.datetime.now().isoformat(),
        "project": project_name,
    }
    with open(NOTIFY_FILE, "a") as f:
        f.write(json.dumps(notification) + "\n")


def git_ls_files(project_path):
    """Get list of tracked files."""
    try:
        result = subprocess.run(
            ["git", "ls-files"],
            capture_output=True, text=True, timeout=10, cwd=project_path,
        )
        if result.returncode != 0:
            return []
        return [f for f in result.stdout.strip().split("\n") if f]
    except Exception:
        return []


def gh_api(endpoint):
    try:
        result = subprocess.run(
            [GH_PATH, "api", endpoint],
            capture_output=True, text=True, timeout=30,
        )
        if result.returncode != 0:
            return None
        return json.loads(result.stdout) if result.stdout.strip() else None
    except Exception:
        return None


# ─── Check Functions ──────────────────────────────────────────────────

def check_secrets(project_path, files):
    """Scan tracked files for hardcoded secrets."""
    findings = []
    # Skip binary, asset, lock, doc, and type-definition-heavy files
    skip_ext = {
        ".lock", ".svg", ".png", ".jpg", ".gif", ".ico", ".woff", ".woff2",
        ".ttf", ".eot", ".map", ".pdf", ".zip", ".tar", ".gz",
    }
    # Docs/plans/examples often contain placeholder tokens — skip them
    skip_dirs = {"plans", "docs", "examples", "fixtures", "sdk-reference", "__tests__", "__mocks__"}

    for rel_path in files:
        ext = os.path.splitext(rel_path)[1].lower()
        if ext in skip_ext:
            continue
        # Skip markdown and documentation files
        if ext in (".md", ".rst", ".txt"):
            continue
        # Skip example/sample/template config files
        base = os.path.basename(rel_path).lower()
        if any(tag in base for tag in ["example", "sample", "template"]):
            continue
        # Skip test files
        if any(tag in rel_path for tag in ["test", "spec", "__test__", "__mock__"]):
            continue
        # Skip known non-source directories
        parts = rel_path.replace("\\", "/").split("/")
        if any(p in skip_dirs for p in parts):
            continue

        full_path = os.path.join(project_path, rel_path)
        if not os.path.exists(full_path):
            continue

        try:
            with open(full_path, "r", errors="ignore") as f:
                for line_num, line in enumerate(f, 1):
                    stripped = line.strip()
                    # Skip comments
                    if stripped.startswith("//") or stripped.startswith("#") or stripped.startswith("*"):
                        continue
                    # Skip type annotations and interface definitions
                    if re.search(r'^\s*(?:type|interface|export\s+(?:type|interface))\b', line):
                        continue
                    # Skip lines that are clearly examples/placeholders/defaults
                    if any(placeholder in line.lower() for placeholder in [
                        "example", "placeholder", "your_", "xxx", "<token>", "${",
                        "localhost", "127.0.0.1", "default",
                    ]):
                        continue

                    for pattern, desc in COMPILED_SECRETS:
                        if pattern.search(line):
                            findings.append({
                                "check": "secrets",
                                "severity": "critical",
                                "file": rel_path,
                                "line": line_num,
                                "message": f"Possible {desc}",
                            })
                            break  # One finding per line max
        except Exception:
            continue

    return findings


def check_debug(project_path, files):
    """Find debug artifacts in non-test source files.

    Only flags `debugger` statements (always debug-only) and reports
    console.log as an aggregate count per file rather than per-line,
    since console.log is often used for legitimate server-side logging.
    """
    findings = []
    source_ext = {".ts", ".js", ".tsx", ".jsx"}
    skip_patterns = ["test", "spec", "__test__", "node_modules", ".test.", ".spec.", ".config."]

    for rel_path in files:
        ext = os.path.splitext(rel_path)[1].lower()
        if ext not in source_ext:
            continue
        if any(skip in rel_path for skip in skip_patterns):
            continue

        full_path = os.path.join(project_path, rel_path)
        if not os.path.exists(full_path):
            continue

        try:
            console_log_count = 0
            with open(full_path, "r", errors="ignore") as f:
                for line_num, line in enumerate(f, 1):
                    if re.search(r'\bdebugger\b', line):
                        findings.append({
                            "check": "debug",
                            "severity": "medium",
                            "file": rel_path,
                            "line": line_num,
                            "message": "Debug artifact: debugger statement",
                        })
                    if re.search(r'\bconsole\.log\(', line):
                        console_log_count += 1

            # Only flag files with excessive console.log (likely debug dumps)
            if console_log_count > 5:
                findings.append({
                    "check": "debug",
                    "severity": "info",
                    "file": rel_path,
                    "line": 0,
                    "message": f"{console_log_count} console.log calls (review for debug leftovers)",
                })
        except Exception:
            continue

    return findings


def check_env(project_path, files):
    """Check for committed .env files."""
    findings = []
    for rel_path in files:
        name = os.path.basename(rel_path)
        # Match .env, .env.local, .env.production, etc. but not .env.example
        if name.startswith(".env") and "example" not in name and "template" not in name and "sample" not in name:
            findings.append({
                "check": "env",
                "severity": "high",
                "file": rel_path,
                "line": 0,
                "message": f"Committed environment file: {name}",
            })
    return findings


def check_large_files(project_path, files):
    """Find tracked files larger than 5MB."""
    findings = []
    threshold = 5 * 1024 * 1024  # 5MB

    for rel_path in files:
        full_path = os.path.join(project_path, rel_path)
        if not os.path.exists(full_path):
            continue
        try:
            size = os.path.getsize(full_path)
            if size > threshold:
                size_mb = size / (1024 * 1024)
                findings.append({
                    "check": "large_files",
                    "severity": "high",
                    "file": rel_path,
                    "line": 0,
                    "message": f"Large tracked file: {size_mb:.1f}MB",
                })
        except Exception:
            continue

    return findings


def check_npm_audit(project_path):
    """Run npm audit if package.json and node_modules exist."""
    findings = []
    pkg_path = os.path.join(project_path, "package.json")
    nm_path = os.path.join(project_path, "node_modules")

    if not os.path.exists(pkg_path) or not os.path.exists(nm_path):
        return findings

    try:
        result = subprocess.run(
            ["npm", "audit", "--json"],
            capture_output=True, text=True, timeout=30, cwd=project_path,
        )
        audit = json.loads(result.stdout) if result.stdout.strip() else {}
        vulns = audit.get("vulnerabilities", {})

        severity_map = {"critical": "critical", "high": "high", "moderate": "medium", "low": "info"}

        for name, info in vulns.items():
            sev = severity_map.get(info.get("severity", ""), "info")
            via = info.get("via", [])
            desc = ""
            if via and isinstance(via[0], dict):
                desc = via[0].get("title", "")
            elif via and isinstance(via[0], str):
                desc = f"via {via[0]}"

            findings.append({
                "check": "npm_audit",
                "severity": sev,
                "file": "package.json",
                "line": 0,
                "message": f"{name}: {desc}" if desc else f"{name} ({info.get('severity', 'unknown')})",
            })
    except Exception as e:
        print(f"  npm audit error: {e}", file=sys.stderr)

    return findings


def check_todos(project_path):
    """Count TODO/FIXME/HACK comments via git grep."""
    findings = []
    markers = ["TODO", "FIXME", "HACK"]

    for marker in markers:
        try:
            result = subprocess.run(
                ["git", "grep", "-c", "--", marker, ":!heartbeat-tasks/scripts/repo-scanner.py", ":!heartbeat-tasks/scripts/code-review.py"],
                capture_output=True, text=True, timeout=10, cwd=project_path,
            )
            if result.returncode == 0 and result.stdout.strip():
                total = 0
                for line in result.stdout.strip().split("\n"):
                    parts = line.rsplit(":", 1)
                    if len(parts) == 2:
                        total += int(parts[1])
                if total > 0:
                    findings.append({
                        "check": "todos",
                        "severity": "info",
                        "file": "",
                        "line": 0,
                        "message": f"{total} {marker} comment(s) across repo",
                    })
        except Exception:
            continue

    return findings


def check_dependabot(repo):
    """Check for open Dependabot alerts via GitHub API."""
    findings = []
    if not repo:
        return findings

    alerts = gh_api(f"/repos/{repo}/dependabot/alerts?state=open&per_page=20")
    if not alerts or not isinstance(alerts, list):
        return findings

    severity_map = {"critical": "critical", "high": "high", "medium": "medium", "low": "info"}

    for alert in alerts:
        sev_obj = alert.get("security_advisory", {}).get("severity", "")
        sev = severity_map.get(sev_obj, "info")
        pkg = alert.get("dependency", {}).get("package", {}).get("name", "unknown")
        title = alert.get("security_advisory", {}).get("summary", "")

        findings.append({
            "check": "dependabot",
            "severity": sev,
            "file": "",
            "line": 0,
            "message": f"Dependabot: {pkg} — {title}" if title else f"Dependabot alert for {pkg}",
        })

    return findings


# ─── Main Scanner ─────────────────────────────────────────────────────

ALL_CHECKS = ["secrets", "debug", "env", "large_files", "npm_audit", "todos", "dependabot"]


def scan_project(name, project_cfg, checks=None):
    """Run all checks on a single project. Returns findings list."""
    path = resolve_path(project_cfg["path"])
    repo = project_cfg.get("repo")
    active_checks = checks or ALL_CHECKS

    if not os.path.isdir(path):
        return [{"check": "setup", "severity": "high", "file": "", "line": 0,
                 "message": f"Project path not found: {path}"}]

    files = git_ls_files(path)
    if not files:
        return [{"check": "setup", "severity": "info", "file": "", "line": 0,
                 "message": "No tracked files (not a git repo or empty)"}]

    findings = []

    if "secrets" in active_checks:
        findings.extend(check_secrets(path, files))
    if "debug" in active_checks:
        findings.extend(check_debug(path, files))
    if "env" in active_checks:
        findings.extend(check_env(path, files))
    if "large_files" in active_checks:
        findings.extend(check_large_files(path, files))
    if "npm_audit" in active_checks:
        findings.extend(check_npm_audit(path))
    if "todos" in active_checks:
        findings.extend(check_todos(path))
    if "dependabot" in active_checks:
        findings.extend(check_dependabot(repo))

    return findings


def summarize(findings):
    """Count findings by severity."""
    summary = {"critical": 0, "high": 0, "medium": 0, "info": 0}
    for f in findings:
        sev = f.get("severity", "info")
        summary[sev] = summary.get(sev, 0) + 1
    return summary


def main():
    parser = argparse.ArgumentParser(description="Repo security scanner")
    parser.add_argument("--project", help="Scan a specific project only")
    parser.add_argument("--json", action="store_true", help="Output as JSON (for MCP tool)")
    parser.add_argument("--checks", help="Comma-separated list of checks to run")
    args = parser.parse_args()

    projects = load_projects()
    if not projects:
        print("No projects in projects.json")
        return

    checks = args.checks.split(",") if args.checks else None

    # Filter to single project if specified
    if args.project:
        if args.project not in projects:
            msg = f"Project '{args.project}' not found in registry"
            if args.json:
                print(json.dumps({"error": msg, "findings": [], "summary": {}}))
            else:
                print(msg)
            return
        projects = {args.project: projects[args.project]}

    state = load_state()
    all_results = {}

    for name, cfg in projects.items():
        print(f"Scanning {name}...", file=sys.stderr)
        findings = scan_project(name, cfg, checks)
        summary = summarize(findings)
        all_results[name] = {"findings": findings, "summary": summary}

        # ── State management: detect NEW findings ──
        proj_state = state.get(name, {"finding_hashes": [], "summary": {}, "last_scan": ""})
        known_hashes = set(proj_state.get("finding_hashes", []))
        current_hashes = set()
        new_critical_high = []

        for f in findings:
            h = finding_hash(f["check"], f.get("file", ""), f.get("line", 0), f["message"])
            current_hashes.add(h)
            if h not in known_hashes and f["severity"] in ("critical", "high"):
                new_critical_high.append(f)

        # ── Notify Discord for new critical/high findings ──
        if new_critical_high and not args.json:
            channel = cfg.get("discord_channel", "notifications")
            msg_parts = [f"**🔒 Security Scan: {name}** — {len(new_critical_high)} new finding(s)"]
            for f in new_critical_high[:5]:
                icon = "🔴" if f["severity"] == "critical" else "🟠"
                msg_parts.append(f"{icon} [{f['severity'].upper()}] {f['check']}: {f['message']}")
            if len(new_critical_high) > 5:
                msg_parts.append(f"... and {len(new_critical_high) - 5} more")
            notify(channel, "\n".join(msg_parts), name)

        # ── Write vault scouted report for critical/high ──
        if (summary.get("critical", 0) > 0 or summary.get("high", 0) > 0) and not args.json:
            os.makedirs(SCOUTED_DIR, exist_ok=True)
            today = datetime.date.today().isoformat()
            report_path = os.path.join(SCOUTED_DIR, f"security-scan-{name}-{today}.md")
            report_lines = [
                "---",
                f"title: Security Scan — {name}",
                f"date: {today}",
                f"scope: shared",
                f"project: {name}",
                "type: security-scan",
                "---",
                "",
                f"# Security Scan: {name}",
                f"Date: {today}",
                f"Critical: {summary.get('critical', 0)} | High: {summary.get('high', 0)} | Medium: {summary.get('medium', 0)} | Info: {summary.get('info', 0)}",
                "",
            ]
            for f in findings:
                if f["severity"] in ("critical", "high"):
                    report_lines.append(f"- **[{f['severity'].upper()}]** {f['check']}: {f['message']}")
                    if f.get("file"):
                        report_lines.append(f"  File: {f['file']}")
            with open(report_path, "w") as rf:
                rf.write("\n".join(report_lines) + "\n")

        # Update state
        state[name] = {
            "finding_hashes": list(current_hashes),
            "summary": summary,
            "last_scan": datetime.datetime.now().isoformat(),
        }

    if not args.json:
        save_state(state)

    # ── Output ──
    if args.json:
        # For MCP tool: output single project results
        if args.project and args.project in all_results:
            print(json.dumps(all_results[args.project]))
        else:
            print(json.dumps(all_results))
    else:
        for name, result in all_results.items():
            s = result["summary"]
            total = sum(s.values())
            print(f"{name}: {total} findings (critical={s['critical']}, high={s['high']}, medium={s['medium']}, info={s['info']})")


if __name__ == "__main__":
    main()
