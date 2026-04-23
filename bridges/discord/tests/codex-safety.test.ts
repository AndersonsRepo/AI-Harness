import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { buildCodexConfig } from "../codex-config.js";
import { agentAllowsWrite } from "../agent-loader.js";
import { setChannelConfig, clearChannelConfig } from "../channel-config-store.js";

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
