import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { buildCodexConfig } from "../codex-config.js";
import { agentAllowsWrite } from "../agent-loader.js";
import { setChannelConfig, clearChannelConfig } from "../channel-config-store.js";
import { setSession, clearSession } from "../session-store.js";

const TEST_CHANNEL = "test-codex-safety-000000000";

function sandboxFrom(args: string[]): string | undefined {
  const idx = args.indexOf("-s");
  return idx >= 0 ? args[idx + 1] : undefined;
}

describe("agentAllowsWrite", () => {
  it("returns false for agents whose whitelist excludes Edit/Write", () => {
    assert.equal(agentAllowsWrite("researcher"), false);
    assert.equal(agentAllowsWrite("reviewer"), false);
    assert.equal(agentAllowsWrite("tester"), false);
    assert.equal(agentAllowsWrite("education"), false);
  });

  it("returns false for orchestrator (Edit/Write explicitly disallowed)", () => {
    assert.equal(agentAllowsWrite("orchestrator"), false);
  });

  it("returns true for unrestricted agents (builder, ops, project)", () => {
    assert.equal(agentAllowsWrite("builder"), true);
    assert.equal(agentAllowsWrite("ops"), true);
    assert.equal(agentAllowsWrite("project"), true);
  });

  it("returns true for scheduler (whitelist includes Edit/Write)", () => {
    assert.equal(agentAllowsWrite("scheduler"), true);
  });

  it("returns true for null/unknown agents (no restrictions profile)", () => {
    assert.equal(agentAllowsWrite(null), true);
    assert.equal(agentAllowsWrite(undefined), true);
    assert.equal(agentAllowsWrite("does-not-exist-agent"), true);
  });
});

describe("Codex sandbox selection", () => {
  before(() => {
    setChannelConfig(TEST_CHANNEL, { runtime: "codex" });
  });

  after(() => {
    clearChannelConfig(TEST_CHANNEL);
  });

  it("builder gets workspace-write sandbox", async () => {
    const cfg = await buildCodexConfig({
      channelId: TEST_CHANNEL,
      prompt: "noop",
      agentName: "builder",
    });
    assert.equal(sandboxFrom(cfg.runnerArgs), "workspace-write");
  });

  it("reviewer gets read-only sandbox (role-level guard)", async () => {
    const cfg = await buildCodexConfig({
      channelId: TEST_CHANNEL,
      prompt: "noop",
      agentName: "reviewer",
    });
    assert.equal(sandboxFrom(cfg.runnerArgs), "read-only");
  });

  it("researcher gets read-only sandbox (role-level guard)", async () => {
    const cfg = await buildCodexConfig({
      channelId: TEST_CHANNEL,
      prompt: "noop",
      agentName: "researcher",
    });
    assert.equal(sandboxFrom(cfg.runnerArgs), "read-only");
  });

  it("orchestrator gets read-only sandbox (role-level guard)", async () => {
    const cfg = await buildCodexConfig({
      channelId: TEST_CHANNEL,
      prompt: "noop",
      agentName: "orchestrator",
    });
    assert.equal(sandboxFrom(cfg.runnerArgs), "read-only");
  });

  it("tester gets read-only sandbox", async () => {
    const cfg = await buildCodexConfig({
      channelId: TEST_CHANNEL,
      prompt: "noop",
      agentName: "tester",
    });
    assert.equal(sandboxFrom(cfg.runnerArgs), "read-only");
  });
});

describe("Codex session resume", () => {
  const CHAN = "test-codex-resume-000000000";

  before(() => {
    setChannelConfig(CHAN, { runtime: "codex" });
  });

  after(() => {
    clearSession(CHAN, "codex");
    clearChannelConfig(CHAN);
  });

  it("omits --session-id when no Codex session is stored (cold start)", async () => {
    clearSession(CHAN, "codex");
    const cfg = await buildCodexConfig({
      channelId: CHAN,
      prompt: "first message",
      agentName: "builder",
    });
    assert.equal(cfg.runnerArgs.includes("--session-id"), false);
  });

  it("passes --session-id <thread> when a Codex session exists for sessionKey", async () => {
    setSession(CHAN, "existing-thread-xyz", "codex");
    const cfg = await buildCodexConfig({
      channelId: CHAN,
      prompt: "continuation",
      agentName: "builder",
    });
    const idx = cfg.runnerArgs.indexOf("--session-id");
    assert.ok(idx >= 0, "--session-id must be passed when session exists");
    assert.equal(cfg.runnerArgs[idx + 1], "existing-thread-xyz");
    // --session-id must appear before the codex CLI args (--json is the first
    // of those) so codex-runner.py's arg parser consumes it.
    const jsonIdx = cfg.runnerArgs.indexOf("--json");
    assert.ok(idx < jsonIdx, "--session-id must appear before --json");
  });

  it("ignores stored session when skipSessionResume is set", async () => {
    setSession(CHAN, "existing-thread-xyz", "codex");
    const cfg = await buildCodexConfig({
      channelId: CHAN,
      prompt: "start fresh",
      agentName: "builder",
      skipSessionResume: true,
    });
    assert.equal(cfg.runnerArgs.includes("--session-id"), false);
  });

  it("only reads Codex sessions, not Claude sessions under the same key", async () => {
    clearSession(CHAN, "codex");
    setSession(CHAN, "some-claude-session-id", "claude");
    const cfg = await buildCodexConfig({
      channelId: CHAN,
      prompt: "noop",
      agentName: "builder",
    });
    assert.equal(cfg.runnerArgs.includes("--session-id"), false);
    clearSession(CHAN, "claude");
  });
});
