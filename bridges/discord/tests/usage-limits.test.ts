import { after, afterEach, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  formatClaudeUsage,
  getCachedClaudeUsage,
  refreshClaudeUsage,
  setUsageFetchForTests,
  setUsageLimitsFileForTests,
  setUsageTokenReaderForTests,
} from "../usage-limits.js";

let CACHE: string;

const SAMPLE = {
  five_hour: { utilization: 62, resets_at: "2026-05-27T06:30:00Z" },
  seven_day: { utilization: 68, resets_at: "2026-05-31T09:00:00Z" },
  seven_day_sonnet: { utilization: 7, resets_at: "2026-05-31T09:00:00Z" },
  extra_usage: { used_credits: 0, monthly_limit: 10000 },
};

describe("usage-limits probe", () => {
  before(() => {
    CACHE = join(mkdtempSync(join(tmpdir(), "ul-test-")), ".usage-limits.json");
    setUsageLimitsFileForTests(CACHE);
  });
  after(() => {
    setUsageLimitsFileForTests(null);
    setUsageTokenReaderForTests(null);
    setUsageFetchForTests(null);
  });
  afterEach(() => {
    if (existsSync(CACHE)) rmSync(CACHE);
  });

  it("returns a no-token error when the keychain is unreadable", async () => {
    setUsageTokenReaderForTests(() => null);
    const d = await refreshClaudeUsage();
    assert.match(d.error || "", /no-token/);
  });

  it("fetches, parses, caches, and formats the real windows", async () => {
    setUsageTokenReaderForTests(() => "fake-token");
    setUsageFetchForTests(async () => ({ ok: true, status: 200, json: async () => SAMPLE }));

    const d = await refreshClaudeUsage();
    assert.equal(d.error, undefined);
    assert.equal(d.five_hour?.utilization, 62);
    // cache round-trip
    assert.equal(getCachedClaudeUsage()?.seven_day?.utilization, 68);
    // format
    const line = formatClaudeUsage(d);
    assert.match(line, /Session 62%/);
    assert.match(line, /Week 68%/);
    assert.match(line, /Sonnet 7%/);
  });

  it("surfaces an HTTP error status (e.g. stale token → 401)", async () => {
    setUsageTokenReaderForTests(() => "fake-token");
    setUsageFetchForTests(async () => ({ ok: false, status: 401, json: async () => ({}) }));
    const d = await refreshClaudeUsage();
    assert.match(d.error || "", /http-401/);
  });

  it("formats missing / error states gracefully", () => {
    assert.match(formatClaudeUsage(null), /not fetched/);
    assert.match(formatClaudeUsage({ fetchedAt: Date.now(), error: "timeout" }), /unavailable \(timeout\)/);
  });
});
