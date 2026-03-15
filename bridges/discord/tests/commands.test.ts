/**
 * Core Commands Tests
 *
 * Tests transport-agnostic command handlers.
 *
 * Run: cd bridges/discord && HARNESS_ROOT=../.. npx tsx --test tests/commands.test.ts
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { executeCommand, type CommandContext } from "../core-commands.js";

function makeCtx(overrides: Partial<CommandContext> = {}): CommandContext {
  return {
    channelId: "test-chan-1",
    userId: "test-user-1",
    rawText: "/status",
    ...overrides,
  };
}

describe("Core Commands — Basic Commands", () => {
  it("/status returns session info", async () => {
    const result = await executeCommand(makeCtx({ rawText: "/status" }));
    assert.ok(result);
    assert.ok(result.text.toLowerCase().includes("session"));
  });

  it("/new clears session", async () => {
    const result = await executeCommand(makeCtx({ rawText: "/new" }));
    assert.ok(result);
    assert.ok(result.text.includes("Cleared") || result.text.includes("No active"));
  });

  it("/stop with no running task", async () => {
    const result = await executeCommand(makeCtx({ rawText: "/stop" }));
    assert.ok(result);
    assert.equal(result.text, "Nothing running in this channel.");
  });

  it("/agents lists agents", async () => {
    const result = await executeCommand(makeCtx({ rawText: "/agents" }));
    assert.ok(result);
    assert.ok(result.text.includes("agent"));
  });

  it("/config with no config", async () => {
    const result = await executeCommand(makeCtx({ rawText: "/config", channelId: "nonexistent-chan" }));
    assert.ok(result);
    assert.ok(result.text.includes("No configuration") || result.text.includes("Config"));
  });

  it("/vault-status returns stats", async () => {
    const result = await executeCommand(makeCtx({ rawText: "/vault-status" }));
    assert.ok(result);
    assert.ok(result.text.includes("Vault Status"));
  });

  it("/db-status returns database info", async () => {
    const result = await executeCommand(makeCtx({ rawText: "/db-status" }));
    assert.ok(result);
    assert.ok(result.text.includes("Database Status"));
  });

  it("/dead-letter returns dead letter list", async () => {
    const result = await executeCommand(makeCtx({ rawText: "/dead-letter" }));
    assert.ok(result);
    assert.ok(result.text.includes("dead-letter") || result.text.includes("Dead"));
  });

  it("/tasks returns running subagents", async () => {
    const result = await executeCommand(makeCtx({ rawText: "/tasks" }));
    assert.ok(result);
    assert.ok(result.text.includes("subagent") || result.text.includes("Running"));
  });

  it("/project list returns projects", async () => {
    const result = await executeCommand(makeCtx({ rawText: "/project list" }));
    assert.ok(result);
    assert.ok(result.text.includes("project") || result.text.includes("Project"));
  });
});

describe("Core Commands — Agent Commands", () => {
  it("/agent clear on unset channel", async () => {
    const result = await executeCommand(makeCtx({ rawText: "/agent clear", channelId: "no-agent-chan" }));
    assert.ok(result);
    assert.ok(result.text.includes("No agent") || result.text.includes("cleared"));
  });

  it("/agent nonexistent returns error", async () => {
    const result = await executeCommand(makeCtx({ rawText: "/agent nonexistent_agent_xyz" }));
    assert.ok(result);
    assert.ok(result.text.includes("not found"));
  });

  it("/model sets model override", async () => {
    const result = await executeCommand(makeCtx({ rawText: "/model claude-sonnet-4-6" }));
    assert.ok(result);
    assert.ok(result.text.includes("model set"));
  });
});

describe("Core Commands — Unknown Commands", () => {
  it("returns null for unknown commands", async () => {
    const result = await executeCommand(makeCtx({ rawText: "/foobar" }));
    assert.equal(result, null);
  });

  it("returns null for Discord-specific commands", async () => {
    assert.equal(await executeCommand(makeCtx({ rawText: "/channel create test" })), null);
    assert.equal(await executeCommand(makeCtx({ rawText: "/project create foo \"bar\"" })), null);
    assert.equal(await executeCommand(makeCtx({ rawText: "/project adopt" })), null);
    assert.equal(await executeCommand(makeCtx({ rawText: "/project close" })), null);
  });
});

describe("Core Commands — Retry/Cancel", () => {
  it("/retry with nonexistent ID", async () => {
    const result = await executeCommand(makeCtx({ rawText: "/retry dl-nonexistent" }));
    assert.ok(result);
    assert.ok(result.text.includes("not found"));
  });

  it("/cancel with nonexistent ID", async () => {
    const result = await executeCommand(makeCtx({ rawText: "/cancel sub-nonexistent" }));
    assert.ok(result);
    assert.ok(result.text.includes("not found") || result.text.includes("not running"));
  });
});
