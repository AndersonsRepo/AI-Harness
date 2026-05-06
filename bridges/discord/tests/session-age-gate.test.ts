/**
 * Session age-gate — getSession({ maxAgeMs }) skips stale sessions to
 * avoid Codex `exec resume <stale-id>` hanging silently for 10+ minutes.
 *
 * Covers:
 *   - Fresh session (last_response_at within window) returns the id.
 *   - Stale session (last_response_at outside window) returns null.
 *   - Session with no last_response_at returns null when maxAge is set.
 *   - Calls without maxAgeMs preserve the original "always return" behavior.
 *   - setSession bumps last_response_at on insert AND update.
 *   - claude-config + codex-config skip --resume / --session-id when
 *     the stored session is older than SESSION_RESUME_MAX_AGE_MS.
 *
 * Run: HARNESS_ROOT=$PWD npx --prefix bridges/discord tsx --test \
 *      bridges/discord/tests/session-age-gate.test.ts
 */

import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { getDb } from "../db.js";
import { getSession, setSession, clearSession, SESSION_RESUME_MAX_AGE_MS } from "../session-store.js";
import { buildCodexConfig } from "../codex-config.js";
import { buildClaudeConfig } from "../claude-config.js";

const FRESH_CHAN = "age-gate-fresh-chan";
const STALE_CHAN = "age-gate-stale-chan";
const NULLAGE_CHAN = "age-gate-null-chan";

function cleanup(channelIds: string[]): void {
  const db = getDb();
  for (const id of channelIds) {
    db.prepare("DELETE FROM sessions WHERE channel_id = ?").run(id);
  }
}

function setLastResponseAt(channelId: string, runtime: "claude" | "codex", iso: string): void {
  const db = getDb();
  db.prepare(
    "UPDATE sessions SET last_response_at = ? WHERE channel_id = ? AND runtime = ?",
  ).run(iso, channelId, runtime);
}

function setLastResponseAtNull(channelId: string, runtime: "claude" | "codex"): void {
  const db = getDb();
  db.prepare(
    "UPDATE sessions SET last_response_at = NULL WHERE channel_id = ? AND runtime = ?",
  ).run(channelId, runtime);
}

// ─── getSession with maxAgeMs ────────────────────────────────────────

describe("getSession({ maxAgeMs }) — age gate", () => {
  beforeEach(() => cleanup([FRESH_CHAN, STALE_CHAN, NULLAGE_CHAN]));
  afterEach(() => cleanup([FRESH_CHAN, STALE_CHAN, NULLAGE_CHAN]));

  it("returns the session id when last_response_at is fresh", () => {
    setSession(FRESH_CHAN, "session-fresh-1", "codex");
    // last_response_at was just bumped to now; well within any window.
    const got = getSession(FRESH_CHAN, "codex", { maxAgeMs: 60_000 });
    assert.equal(got, "session-fresh-1");
  });

  it("returns null when last_response_at is older than the window", () => {
    setSession(STALE_CHAN, "session-stale-1", "codex");
    // Force last_response_at to 25 hours ago.
    const stale = new Date(Date.now() - 25 * 60 * 60 * 1000)
      .toISOString()
      .replace("T", " ")
      .slice(0, 19);
    setLastResponseAt(STALE_CHAN, "codex", stale);

    const got = getSession(STALE_CHAN, "codex", { maxAgeMs: 24 * 60 * 60 * 1000 });
    assert.equal(got, null, "stale session must be skipped on age-bounded read");
  });

  it("returns null when last_response_at is NULL and maxAgeMs is set", () => {
    setSession(NULLAGE_CHAN, "session-nulled", "codex");
    setLastResponseAtNull(NULLAGE_CHAN, "codex");

    const got = getSession(NULLAGE_CHAN, "codex", { maxAgeMs: 60_000 });
    assert.equal(got, null, "null timestamp must be treated as stale when gating");
  });

  it("ignores age when maxAgeMs is omitted (back-compat)", () => {
    setSession(STALE_CHAN, "session-stale-2", "codex");
    const ancient = "2020-01-01 00:00:00";
    setLastResponseAt(STALE_CHAN, "codex", ancient);

    const got = getSession(STALE_CHAN, "codex");
    assert.equal(got, "session-stale-2", "no maxAgeMs => age check disabled");
  });

  it("default SESSION_RESUME_MAX_AGE_MS is 24h", () => {
    assert.equal(SESSION_RESUME_MAX_AGE_MS, 24 * 60 * 60 * 1000);
  });
});

// ─── setSession bumps last_response_at ───────────────────────────────

describe("setSession — last_response_at lifecycle", () => {
  const CHAN = "age-gate-bump-chan";
  beforeEach(() => cleanup([CHAN]));
  afterEach(() => cleanup([CHAN]));

  it("populates last_response_at on insert", () => {
    setSession(CHAN, "first-id", "codex");
    const db = getDb();
    const row = db.prepare(
      "SELECT last_response_at FROM sessions WHERE channel_id = ? AND runtime = 'codex'",
    ).get(CHAN) as { last_response_at: string | null } | undefined;
    assert.ok(row);
    assert.ok(row!.last_response_at, "last_response_at must be set on insert");
  });

  it("bumps last_response_at on update (resume succeeded with same id)", () => {
    setSession(CHAN, "same-id", "codex");
    const stale = "2020-01-01 00:00:00";
    setLastResponseAt(CHAN, "codex", stale);

    setSession(CHAN, "same-id", "codex"); // simulating successful response
    const db = getDb();
    const row = db.prepare(
      "SELECT last_response_at FROM sessions WHERE channel_id = ? AND runtime = 'codex'",
    ).get(CHAN) as { last_response_at: string | null } | undefined;
    assert.ok(row);
    assert.notEqual(row!.last_response_at, stale, "must be refreshed");
  });
});

// ─── Config builders honor the age gate ──────────────────────────────

describe("buildCodexConfig — age-gated --session-id", () => {
  const CHAN = "age-gate-codex-cfg";
  beforeEach(() => cleanup([CHAN]));
  afterEach(() => cleanup([CHAN]));

  it("includes --session-id for a fresh stored session", async () => {
    setSession(CHAN, "fresh-thread-id", "codex");
    const cfg = await buildCodexConfig({
      channelId: CHAN,
      prompt: "test",
      agentName: "researcher",
      sessionKey: CHAN,
      taskId: "test-task",
    });
    const idx = cfg.runnerArgs.indexOf("--session-id");
    assert.ok(idx >= 0, "--session-id must be passed for a fresh session");
    assert.equal(cfg.runnerArgs[idx + 1], "fresh-thread-id");
  });

  it("omits --session-id when the stored session is older than the window", async () => {
    setSession(CHAN, "stale-thread-id", "codex");
    const stale = new Date(Date.now() - (SESSION_RESUME_MAX_AGE_MS + 60_000))
      .toISOString()
      .replace("T", " ")
      .slice(0, 19);
    setLastResponseAt(CHAN, "codex", stale);

    const cfg = await buildCodexConfig({
      channelId: CHAN,
      prompt: "test",
      agentName: "researcher",
      sessionKey: CHAN,
      taskId: "test-task",
    });
    assert.equal(
      cfg.runnerArgs.indexOf("--session-id"),
      -1,
      "stale session must NOT be passed; codex-runner cold-starts a fresh thread",
    );
  });

  it("respects skipSessionResume regardless of age", async () => {
    setSession(CHAN, "fresh-but-skip", "codex");
    const cfg = await buildCodexConfig({
      channelId: CHAN,
      prompt: "test",
      agentName: "researcher",
      sessionKey: CHAN,
      taskId: "test-task",
      skipSessionResume: true,
    });
    assert.equal(cfg.runnerArgs.indexOf("--session-id"), -1);
  });
});

describe("buildClaudeConfig — age-gated --resume", () => {
  const CHAN = "age-gate-claude-cfg";
  beforeEach(() => cleanup([CHAN]));
  afterEach(() => cleanup([CHAN]));

  it("includes --resume for a fresh stored session", async () => {
    setSession(CHAN, "fresh-claude-sess", "claude");
    const cfg = await buildClaudeConfig({
      channelId: CHAN,
      prompt: "test",
      agentName: null,
      sessionKey: CHAN,
      taskId: "test-task",
    });
    const idx = cfg.args.indexOf("--resume");
    assert.ok(idx >= 0, "--resume must be passed for a fresh session");
    assert.equal(cfg.args[idx + 1], "fresh-claude-sess");
  });

  it("omits --resume when the stored session is older than the window", async () => {
    setSession(CHAN, "stale-claude-sess", "claude");
    const stale = new Date(Date.now() - (SESSION_RESUME_MAX_AGE_MS + 60_000))
      .toISOString()
      .replace("T", " ")
      .slice(0, 19);
    setLastResponseAt(CHAN, "claude", stale);

    const cfg = await buildClaudeConfig({
      channelId: CHAN,
      prompt: "test",
      agentName: null,
      sessionKey: CHAN,
      taskId: "test-task",
    });
    assert.equal(cfg.args.indexOf("--resume"), -1);
  });
});

// ─── Migration v20 — schema sanity ───────────────────────────────────

describe("Schema v20 — last_response_at column", () => {
  it("sessions table has last_response_at column", () => {
    const db = getDb();
    const cols = db.prepare("PRAGMA table_info(sessions)").all() as Array<{ name: string }>;
    const names = cols.map((c) => c.name);
    assert.ok(names.includes("last_response_at"), "v20 migration should have added the column");
  });
});

// Defensive: clear leftover state in case prior tests in the suite left rows.
afterEach(() => clearSession("age-gate-fresh-chan"));
