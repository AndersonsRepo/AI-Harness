import { after, afterEach, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  formatUsageStatus,
  getUsageState,
  recordLimitEvent,
  setUsageStateFileForTests,
} from "../usage-tracker.js";

let STATE: string;

describe("usage-tracker", () => {
  before(() => {
    // Redirect off the live .usage-state.json (panel display data).
    STATE = join(mkdtempSync(join(tmpdir(), "usage-test-")), ".usage-state.json");
    setUsageStateFileForTests(STATE);
  });
  after(() => setUsageStateFileForTests(null));
  afterEach(() => {
    if (existsSync(STATE)) rmSync(STATE);
  });

  it("reports a clean state when nothing recorded", () => {
    assert.match(formatUsageStatus(getUsageState()), /No usage\/rate limits/i);
  });

  it("records a usage_limit hit with runtime and a daily count", () => {
    recordLimitEvent("usage_limit", "claude");
    recordLimitEvent("usage_limit", "claude");
    const status = formatUsageStatus(getUsageState());
    assert.match(status, /Usage limit/);
    assert.match(status, /claude/);
    assert.match(status, /2× today/);
  });

  it("tracks rate_limit separately from usage_limit", () => {
    recordLimitEvent("usage_limit", "claude");
    recordLimitEvent("rate_limit", "claude");
    const status = formatUsageStatus(getUsageState());
    assert.match(status, /Usage limit/);
    assert.match(status, /Rate limit/);
  });

  it("ignores untracked classification kinds", () => {
    recordLimitEvent("overload", "claude");
    recordLimitEvent("auth", "claude");
    assert.match(formatUsageStatus(getUsageState()), /No usage\/rate limits/i);
  });
});
