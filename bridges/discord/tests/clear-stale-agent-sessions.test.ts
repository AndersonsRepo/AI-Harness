import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const harnessRoot = mkdtempSync(join(tmpdir(), "aih-reload-agents-"));
mkdirSync(join(harnessRoot, "bridges", "discord"), { recursive: true });
process.env.HARNESS_ROOT = harnessRoot;

const dbMod = await import("../db.js");
const storeMod = await import("../session-store.js");

const { closeDb, getDb } = dbMod;
const { clearStaleAgentSessions } = storeMod;

// Helper: insert a session with an explicit created_at timestamp.
function insertSession(channelId: string, sessionId: string, createdAt: string): void {
  const db = getDb();
  db.prepare(
    `INSERT OR REPLACE INTO sessions (channel_id, session_id, runtime, created_at, last_used)
     VALUES (?, ?, 'claude', ?, ?)`,
  ).run(channelId, sessionId, createdAt, createdAt);
}

function isoToSqlite(iso: string): string {
  return iso.replace("T", " ").slice(0, 19);
}

describe("clearStaleAgentSessions", () => {
  before(() => {
    getDb(); // ensure schema is created
  });

  after(() => {
    closeDb();
    rmSync(harnessRoot, { recursive: true, force: true });
  });

  it("returns empty when no sessions exist", () => {
    const result = clearStaleAgentSessions(new Map([["orchestrator", Date.now()]]));
    assert.deepEqual(result, []);
  });

  it("clears compound-keyed sessions older than agent mtime", () => {
    const oldCreatedAt = isoToSqlite(new Date(Date.now() - 60_000).toISOString()); // 60s ago
    insertSession("123:orchestrator", "sess-old", oldCreatedAt);
    insertSession("456:orchestrator", "sess-old-2", oldCreatedAt);

    const result = clearStaleAgentSessions(new Map([["orchestrator", Date.now()]]));
    assert.deepEqual(result, [{ agent: "orchestrator", cleared: 2 }]);

    const remaining = getDb()
      .prepare("SELECT COUNT(*) as c FROM sessions WHERE channel_id LIKE '%:orchestrator'")
      .get() as { c: number };
    assert.equal(remaining.c, 0);
  });

  it("preserves sessions newer than agent mtime", () => {
    const recentCreatedAt = isoToSqlite(new Date(Date.now() + 60_000).toISOString()); // 60s in future
    insertSession("789:builder", "sess-fresh", recentCreatedAt);

    const result = clearStaleAgentSessions(new Map([["builder", Date.now()]]));
    assert.deepEqual(result, []);

    const remaining = getDb()
      .prepare("SELECT session_id FROM sessions WHERE channel_id = '789:builder'")
      .get() as { session_id: string } | undefined;
    assert.equal(remaining?.session_id, "sess-fresh");
  });

  it("does not touch non-compound-keyed sessions even when channel uses that agent", () => {
    const oldCreatedAt = isoToSqlite(new Date(Date.now() - 60_000).toISOString());
    insertSession("plain-channel-id", "non-project-sess", oldCreatedAt);

    const result = clearStaleAgentSessions(new Map([["orchestrator", Date.now()]]));
    assert.deepEqual(result, []);

    const remaining = getDb()
      .prepare("SELECT session_id FROM sessions WHERE channel_id = 'plain-channel-id'")
      .get() as { session_id: string } | undefined;
    assert.equal(remaining?.session_id, "non-project-sess");
  });

  it("reports per-agent counts when multiple agents have stale sessions", () => {
    const oldCreatedAt = isoToSqlite(new Date(Date.now() - 60_000).toISOString());
    insertSession("c1:reviewer", "r1", oldCreatedAt);
    insertSession("c2:reviewer", "r2", oldCreatedAt);
    insertSession("c1:tester", "t1", oldCreatedAt);

    const result = clearStaleAgentSessions(
      new Map([
        ["reviewer", Date.now()],
        ["tester", Date.now()],
      ]),
    );

    const byAgent = Object.fromEntries(result.map((r) => [r.agent, r.cleared]));
    assert.equal(byAgent.reviewer, 2);
    assert.equal(byAgent.tester, 1);
  });

  it("omits agents whose mtime predates all their sessions", () => {
    const recentCreatedAt = isoToSqlite(new Date(Date.now() + 120_000).toISOString());
    insertSession("c3:education", "e1", recentCreatedAt);

    // mtime is 60s ago — sessions are 2 minutes in the future, so all are fresh
    const result = clearStaleAgentSessions(new Map([["education", Date.now() - 60_000]]));
    assert.deepEqual(result, []);
  });
});
