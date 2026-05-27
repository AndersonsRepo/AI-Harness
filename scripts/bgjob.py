#!/usr/bin/env python3
"""bgjob — managed background jobs for long-running work (app builds, agent runs, slow LLM
calls, big batch scripts).

WHY THIS EXISTS
The harness executes chat tasks as bounded, short steps with a tool/task timeout. A long
operation run *inline* (e.g. `npm run build`, a multi-minute model call, `generate.py`) blocks
the step, trips the timeout, and — because work is spawned detached so the bot never blocks —
the timeout reaps the *task wrapper* but NOT the underlying process. Result: a runaway orphan
plus a "timed out" task that never delivers. (Root cause + history: vault ERR/LRN on
orphan-on-timeout.)

bgjob fixes that: launch the work as a *managed* detached job — its own session, a tracked id,
captured exit code, and a combined log — then RETURN IMMEDIATELY. The chat task finishes fast;
you (or an agent) poll `bgjob status` / `bgjob logs` and collect the result whenever it's done.
Nothing is orphaned: every job has an id, a status, and a killable process group.

USAGE
  bgjob run "<command>" [--cwd DIR] [--name NAME]   launch; prints JOB_ID (returns immediately)
  bgjob list                                        all jobs, newest first
  bgjob status [JOB_ID]                             status (+ last log lines) of one / all
  bgjob logs JOB_ID [-n N] [--all] [-f]             tail / full / follow the job's output
  bgjob wait JOB_ID [--timeout S]                   block until done; exits with the job's code
  bgjob kill JOB_ID                                 SIGTERM the job's whole process group
  bgjob clean [--keep N]                            prune finished job dirs (keep newest N)

Registry: $HARNESS_ROOT/.bg-jobs/<id>/  (meta.json + out.log). Stdlib only; macOS/Linux.
"""
import argparse
import json
import os
import signal
import subprocess
import sys
import time
from datetime import datetime, timezone

ROOT = os.environ.get("HARNESS_ROOT") or os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
JOBS = os.path.join(ROOT, ".bg-jobs")


def _now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def _jd(jid):
    return os.path.join(JOBS, jid)


def _meta_path(jid):
    return os.path.join(_jd(jid), "meta.json")


def _log_path(jid):
    return os.path.join(_jd(jid), "out.log")


def _read(jid):
    try:
        with open(_meta_path(jid)) as f:
            return json.load(f)
    except Exception:
        return None


def _write(meta):
    jid = meta["id"]
    os.makedirs(_jd(jid), exist_ok=True)
    tmp = _meta_path(jid) + ".tmp"
    with open(tmp, "w") as f:
        json.dump(meta, f, indent=2)
    os.replace(tmp, _meta_path(jid))


def _alive(pid):
    if not pid:
        return False
    try:
        os.kill(int(pid), 0)
        return True
    except (OSError, ValueError):
        return False


def _reconcile(meta):
    """If marked running/launching but the supervisor is dead, the job crashed."""
    if meta and meta.get("status") in ("running", "launching") and not _alive(meta.get("supervisor_pid")):
        meta["status"] = "crashed"
        meta["ended_at"] = meta.get("ended_at") or _now()
        _write(meta)
    return meta


def _elapsed(meta):
    try:
        start = datetime.fromisoformat(meta["started_at"])
        end = datetime.fromisoformat(meta["ended_at"]) if meta.get("ended_at") else datetime.now(timezone.utc)
        s = int((end - start).total_seconds())
        return f"{s//3600}h{(s%3600)//60:02d}m" if s >= 3600 else f"{s//60}m{s%60:02d}s"
    except Exception:
        return "?"


def _all_jobs():
    if not os.path.isdir(JOBS):
        return []
    metas = [_reconcile(_read(d)) for d in os.listdir(JOBS) if os.path.isdir(_jd(d))]
    metas = [m for m in metas if m]
    return sorted(metas, key=lambda m: m.get("started_at", ""), reverse=True)


def _line(meta):
    badge = {"running": "▶", "done": "✓", "failed": "✗", "crashed": "✗", "killed": "■",
             "launching": "…"}.get(meta["status"], "?")
    name = f" [{meta['name']}]" if meta.get("name") else ""
    rc = "" if meta.get("exit_code") is None else f" rc={meta['exit_code']}"
    return f"{badge} {meta['id']}{name}  {meta['status']}{rc}  {_elapsed(meta)}  $ {meta['cmd'][:70]}"


def _tail(jid, n):
    try:
        with open(_log_path(jid)) as f:
            return "".join(f.readlines()[-n:])
    except Exception:
        return ""


def _notify(meta):
    """On completion, ping a Discord channel via the bot's notification drain (the same
    pending-notifications.jsonl pipe heartbeats use). One atomic append; never raises."""
    chan = meta.get("notify")
    if not chan:
        return
    ok = meta.get("status") == "done"
    icon = "✅" if ok else "⚠️"
    label = meta.get("name") or meta["id"]
    msg = (f"{icon} bgjob `{label}` {meta['status']} "
           f"(rc={meta.get('exit_code')}, {_elapsed(meta)}) — see `bgjob logs {meta['id']}`")
    # The LIVE bot (bot-v2 → DiscordTransport) drains heartbeat-tasks/pending-notifications.jsonl
    # and reads the `summary` field (resolves `channel` by exact Discord name). Include
    # message/task too so the other drains (core-gateway/bot.ts) render it as well.
    line = json.dumps({"channel": chan, "task": "bgjob", "summary": msg, "message": msg},
                      ensure_ascii=False) + "\n"
    nd = os.path.join(ROOT, "heartbeat-tasks")
    try:
        os.makedirs(nd, exist_ok=True)
        with open(os.path.join(nd, "pending-notifications.jsonl"), "a") as f:
            f.write(line)  # single small write -> atomic enough for concurrent jobs
    except Exception:
        pass


# ---------------- subcommands ----------------
def cmd_run(a):
    jid = f"{int(time.time() * 1000):x}{os.getpid() & 0xfff:03x}"
    # --notify CHANNEL pings that channel on completion; --notify-here pings THIS
    # task's own channel via $HARNESS_CHANNEL_NAME (injected into the spawned-task
    # env — see LRN-bgjob-notify-drain-and-channel-name-gap). Explicit --notify wins.
    notify_chan = a.notify or (os.environ.get("HARNESS_CHANNEL_NAME") if getattr(a, "notify_here", False) else None)
    if getattr(a, "notify_here", False) and not notify_chan:
        sys.stderr.write("  --notify-here: HARNESS_CHANNEL_NAME not in env; no completion ping will fire\n")
    meta = {"id": jid, "name": a.name or "", "cmd": a.command,
            "cwd": os.path.abspath(a.cwd or os.getcwd()), "status": "launching",
            "notify": notify_chan,
            "supervisor_pid": None, "cmd_pid": None, "pgid": None,
            "exit_code": None, "started_at": _now(), "ended_at": None}
    _write(meta)
    open(_log_path(jid), "w").close()
    # Detached supervisor: start_new_session => its own session/group (pgid == pid), so it
    # survives the chat task that launched it and the whole tree is killable via the group.
    p = subprocess.Popen([sys.executable, os.path.abspath(__file__), "__supervise__", jid],
                         stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
                         stderr=subprocess.DEVNULL, start_new_session=True)
    meta["supervisor_pid"] = p.pid
    meta["pgid"] = p.pid
    _write(meta)
    print(jid)
    sys.stderr.write(f"  launched job {jid} — check: bgjob status {jid} | logs: bgjob logs {jid} -f\n")
    return 0


def _supervise(jid):
    meta = _read(jid)
    if not meta:
        return 1
    shell = os.environ.get("SHELL", "/bin/zsh")
    with open(_log_path(jid), "a") as log:
        # No new session here: child inherits the supervisor's group, so killpg(pgid) reaps all.
        child = subprocess.Popen([shell, "-lc", meta["cmd"]], cwd=meta["cwd"],
                                 stdin=subprocess.DEVNULL, stdout=log, stderr=subprocess.STDOUT)
        meta["cmd_pid"] = child.pid
        meta["status"] = "running"
        _write(meta)
        rc = child.wait()
    meta = _read(jid) or meta
    if meta.get("status") == "killed":  # a kill already set the terminal status
        return 0
    meta["exit_code"] = rc
    meta["ended_at"] = _now()
    meta["status"] = "done" if rc == 0 else "failed"
    _write(meta)
    _notify(meta)
    return 0


def cmd_list(a):
    jobs = _all_jobs()
    if not jobs:
        print("no jobs.")
        return 0
    for m in jobs:
        print(_line(m))
    return 0


def cmd_status(a):
    if not a.job_id:
        return cmd_list(a)
    meta = _reconcile(_read(a.job_id))
    if not meta:
        print(f"no such job: {a.job_id}", file=sys.stderr)
        return 2
    print(_line(meta))
    print(f"  cwd: {meta['cwd']}")
    print(f"  started: {meta['started_at']}" + (f"  ended: {meta['ended_at']}" if meta.get("ended_at") else ""))
    print(f"  pids: supervisor={meta.get('supervisor_pid')} cmd={meta.get('cmd_pid')} pgid={meta.get('pgid')}"
          f" (cmd alive: {_alive(meta.get('cmd_pid'))})")
    tail = _tail(a.job_id, a.lines)
    if tail:
        print(f"  --- last {a.lines} log lines ---")
        for ln in tail.splitlines():
            print("  " + ln)
    return 0


def cmd_logs(a):
    meta = _read(a.job_id)
    if not meta:
        print(f"no such job: {a.job_id}", file=sys.stderr)
        return 2
    if a.follow:
        try:
            subprocess.run(["tail", "-f", "-n", str(a.lines), _log_path(a.job_id)])
        except KeyboardInterrupt:
            pass
        return 0
    if a.all:
        with open(_log_path(a.job_id)) as f:
            sys.stdout.write(f.read())
    else:
        sys.stdout.write(_tail(a.job_id, a.lines))
    return 0


def cmd_wait(a):
    deadline = time.time() + a.timeout if a.timeout else None
    while True:
        meta = _reconcile(_read(a.job_id))
        if not meta:
            print(f"no such job: {a.job_id}", file=sys.stderr)
            return 2
        if meta["status"] not in ("running", "launching"):
            print(_line(meta))
            return meta.get("exit_code") or (0 if meta["status"] == "done" else 1)
        if deadline and time.time() > deadline:
            print(f"still {meta['status']} after {a.timeout}s — {a.job_id}", file=sys.stderr)
            return 124
        time.sleep(2)


def cmd_kill(a):
    meta = _read(a.job_id)
    if not meta:
        print(f"no such job: {a.job_id}", file=sys.stderr)
        return 2
    pgid = meta.get("pgid")
    if pgid and _alive(meta.get("supervisor_pid")):
        try:
            os.killpg(int(pgid), signal.SIGTERM)
        except OSError as e:
            print(f"killpg failed: {e}", file=sys.stderr)
    meta["status"] = "killed"
    meta["ended_at"] = meta.get("ended_at") or _now()
    _write(meta)
    print(f"killed {a.job_id} (process group {pgid})")
    return 0


def cmd_notify(a):
    """Emit a completion notification for an existing job to a channel (for watcher patterns:
    `bgjob wait <id>; bgjob notify <id> <channel>`). Channel falls back to the job's stored
    --notify, then $HARNESS_CHANNEL_NAME."""
    meta = _reconcile(_read(a.job_id))
    if not meta:
        print(f"no such job: {a.job_id}", file=sys.stderr)
        return 2
    chan = a.channel or meta.get("notify") or os.environ.get("HARNESS_CHANNEL_NAME")
    if not chan:
        print("no channel (pass one, set job --notify, or HARNESS_CHANNEL_NAME)", file=sys.stderr)
        return 2
    m = dict(meta)
    m["notify"] = chan
    _notify(m)
    print(f"notified '{chan}' for {a.job_id} ({meta['status']})")
    return 0


def cmd_clean(a):
    jobs = _all_jobs()
    finished = [m for m in jobs if m["status"] in ("done", "failed", "crashed", "killed")]
    import shutil
    removed = 0
    for m in finished[a.keep:]:
        shutil.rmtree(_jd(m["id"]), ignore_errors=True)
        removed += 1
    print(f"removed {removed} finished job(s); kept {min(len(finished), a.keep)} + all active.")
    return 0


def main():
    # Internal: the detached supervisor re-execs this script. Handle before argparse.
    if len(sys.argv) >= 3 and sys.argv[1] == "__supervise__":
        sys.exit(_supervise(sys.argv[2]))

    ap = argparse.ArgumentParser(prog="bgjob", description="Managed background jobs for long-running work.")
    sub = ap.add_subparsers(dest="sub", required=True)

    r = sub.add_parser("run", help="launch a command as a background job")
    r.add_argument("command", help="the command to run (quote it)")
    r.add_argument("--cwd", help="working directory (default: current)")
    r.add_argument("--name", help="optional label")
    r.add_argument("--notify", help="Discord channel name to ping on completion (via the notification drain)")
    r.add_argument("--notify-here", action="store_true",
                   help="ping THIS task's own channel ($HARNESS_CHANNEL_NAME) on completion")
    r.set_defaults(fn=cmd_run)

    sub.add_parser("list", help="list all jobs").set_defaults(fn=cmd_list)

    s = sub.add_parser("status", help="status of one job (or all)")
    s.add_argument("job_id", nargs="?")
    s.add_argument("-n", "--lines", type=int, default=8)
    s.set_defaults(fn=cmd_status)

    lg = sub.add_parser("logs", help="show a job's output")
    lg.add_argument("job_id")
    lg.add_argument("-n", "--lines", type=int, default=40)
    lg.add_argument("--all", action="store_true")
    lg.add_argument("-f", "--follow", action="store_true")
    lg.set_defaults(fn=cmd_logs)

    w = sub.add_parser("wait", help="block until a job finishes")
    w.add_argument("job_id")
    w.add_argument("--timeout", type=int, default=0)
    w.set_defaults(fn=cmd_wait)

    k = sub.add_parser("kill", help="terminate a job's process group")
    k.add_argument("job_id")
    k.set_defaults(fn=cmd_kill)

    nt = sub.add_parser("notify", help="emit a completion notification for a job to a channel")
    nt.add_argument("job_id")
    nt.add_argument("channel", nargs="?")
    nt.set_defaults(fn=cmd_notify)

    c = sub.add_parser("clean", help="prune finished jobs")
    c.add_argument("--keep", type=int, default=20)
    c.set_defaults(fn=cmd_clean)

    a = ap.parse_args()
    sys.exit(a.fn(a))


if __name__ == "__main__":
    main()
