import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import Database from "better-sqlite3";

const harnessRoot = mkdtempSync(join(tmpdir(), "aih-session-compat-"));
mkdirSync(join(harnessRoot, "bridges", "discord"), { recursive: true });
process.env.HARNESS_ROOT = harnessRoot;

const dbMod = await import("../db.js");
const storeMod = await import("../session-store.js");

const { closeDb, getDb } = dbMod;
const { getSession, setSession, clearSession, validateSession } = storeMod;

function replaceSessionsWithLegacySchema(db: Database.Database): void {
  db.exec(`
    DROP TABLE IF EXISTS sessions_legacy;
    CREATE TABLE sessions_legacy (
      channel_id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      runtime TEXT NOT NULL DEFAULT 'claude',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      last_used TEXT NOT NULL DEFAULT (datetime('now'))
    );

    INSERT INTO sessions_legacy (channel_id, session_id, runtime, created_at, last_used)
    SELECT channel_id, session_id, runtime, created_at, last_used
    FROM sessions;

    DROP TABLE sessions;
    ALTER TABLE sessions_legacy RENAME TO sessions;
  `);
}

describe("session-store compatibility with channel-only sessions schema", () => {
  before(() => {
    const db = getDb();
    replaceSessionsWithLegacySchema(db);
  });

  after(() => {
    closeDb();
    rmSync(harnessRoot, { recursive: true, force: true });
  });

  it("reads runtime-scoped lookups without throwing", () => {
    const db = getDb();
    db.prepare(`
      INSERT OR REPLACE INTO sessions (channel_id, session_id, runtime, created_at, last_used)
      VALUES (?, ?, 'claude', datetime('now'), datetime('now'))
    `).run("legacy-chan", "legacy-session");

    assert.equal(getSession("legacy-chan", "codex"), "legacy-session");
  });

  it("writes and clears sessions without runtime-key support", () => {
    setSession("legacy-write", "session-123", "codex");
    assert.equal(getSession("legacy-write", "codex"), "session-123");
    assert.equal(clearSession("legacy-write", "codex"), true);
    assert.equal(getSession("legacy-write", "codex"), null);
  });

  it("validates stale sessions without querying a missing runtime key", () => {
    const db = getDb();
    db.prepare(`
      INSERT OR REPLACE INTO sessions (channel_id, session_id, runtime, created_at, last_used)
      VALUES (?, ?, 'claude', datetime('now'), datetime('now'))
    `).run("legacy-validate", "session-validate");

    assert.equal(validateSession("legacy-validate", "codex"), false);
    assert.equal(getSession("legacy-validate", "codex"), null);
  });
});
