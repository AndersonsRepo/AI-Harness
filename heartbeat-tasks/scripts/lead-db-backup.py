#!/usr/bin/env python3
"""
Heartbeat script: Back up the lead gen pipeline SQLite database.

Creates timestamped backups using SQLite's backup API (safe even during
concurrent reads/writes). Keeps the last 7 backups and deletes older ones.

Also runs PRAGMA wal_checkpoint(TRUNCATE) to merge the WAL into the
main database file, preventing WAL-only data loss.
"""
import json
import os
import sqlite3
import shutil
from datetime import datetime
from pathlib import Path

PIPELINE_DB = Path.home() / "Desktop" / "lead_gen_pipeline" / "leads.db"
BACKUP_DIR = Path.home() / "Desktop" / "lead_gen_pipeline" / "backups"
MAX_BACKUPS = 7
HARNESS_ROOT = Path(__file__).parent.parent.parent
NOTIFICATIONS = HARNESS_ROOT / "pending-notifications.jsonl"


def notify(message, channel="notifications"):
    with open(NOTIFICATIONS, "a") as f:
        f.write(json.dumps({
            "channel": channel,
            "task": "lead-db-backup",
            "summary": message,
            "timestamp": datetime.now().isoformat(),
        }) + "\n")


def main():
    if not PIPELINE_DB.exists():
        print("No leads.db found")
        return

    BACKUP_DIR.mkdir(exist_ok=True)

    # Step 1: Checkpoint WAL to merge data into main DB file
    try:
        db = sqlite3.connect(str(PIPELINE_DB), timeout=10)
        db.execute("PRAGMA busy_timeout = 5000")
        result = db.execute("PRAGMA wal_checkpoint(TRUNCATE)").fetchone()
        print(f"WAL checkpoint: blocked={result[0]}, pages={result[1]}, moved={result[2]}")
        db.close()
    except sqlite3.OperationalError as e:
        print(f"WAL checkpoint failed (DB locked?): {e}")
        # Continue with backup anyway — the backup API handles this

    # Step 2: Create backup using SQLite backup API (safe during concurrent access)
    timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
    backup_path = BACKUP_DIR / f"leads_{timestamp}.db"

    try:
        source = sqlite3.connect(str(PIPELINE_DB))
        dest = sqlite3.connect(str(backup_path))
        source.backup(dest)
        dest.close()
        source.close()

        size_mb = backup_path.stat().st_size / 1024 / 1024
        print(f"Backup created: {backup_path.name} ({size_mb:.1f} MB)")
    except Exception as e:
        print(f"Backup failed: {e}")
        notify(f"**Lead DB Backup Failed**\n{e}")
        return

    # Step 3: Verify backup integrity
    try:
        check_db = sqlite3.connect(str(backup_path))
        result = check_db.execute("PRAGMA integrity_check").fetchone()
        lead_count = check_db.execute("SELECT COUNT(*) FROM leads").fetchone()[0]
        check_db.close()

        if result[0] != "ok":
            print(f"Backup integrity check FAILED: {result[0]}")
            notify(f"**Lead DB Backup Corrupted**\nIntegrity check: {result[0]}")
            backup_path.unlink()
            return

        print(f"Backup verified: {lead_count} leads, integrity OK")
    except Exception as e:
        print(f"Backup verification failed: {e}")
        backup_path.unlink()
        return

    # Step 4: Prune old backups (keep last MAX_BACKUPS)
    backups = sorted(BACKUP_DIR.glob("leads_*.db"), key=lambda p: p.stat().st_mtime, reverse=True)
    pruned = 0
    for old_backup in backups[MAX_BACKUPS:]:
        old_backup.unlink()
        pruned += 1

    if pruned:
        print(f"Pruned {pruned} old backup(s)")

    print(f"Backups: {min(len(backups), MAX_BACKUPS)} retained in {BACKUP_DIR}")


if __name__ == "__main__":
    main()
