import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const harnessRoot = mkdtempSync(join(tmpdir(), "aih-codex-mcp-"));
mkdirSync(join(harnessRoot, "bridges", "discord"), { recursive: true });
process.env.HARNESS_ROOT = harnessRoot;

const { setChannelConfig, clearChannelConfig } = await import("../channel-config-store.js");
const { buildCodexMcpApprovalArgs } = await import("../codex-config.js");

const fixtureDir = mkdtempSync(join(tmpdir(), "aih-codex-toml-"));
const tomlPath = join(fixtureDir, "config.toml");
writeFileSync(
  tomlPath,
  [
    'model = "gpt-5.4"',
    "",
    "[mcp_servers.vault]",
    'command = "node"',
    "",
    "[mcp_servers.harness]",
    'command = "node"',
    "",
    "[mcp_servers.projects]",
    'command = "node"',
    "",
  ].join("\n"),
);

describe("buildCodexMcpApprovalArgs", () => {
  const CHAN = "test-codex-mcp-approval-1";

  after(() => {
    clearChannelConfig(CHAN);
    rmSync(harnessRoot, { recursive: true, force: true });
    rmSync(fixtureDir, { recursive: true, force: true });
  });

  it("emits -c override per intersection of allowlist and codex registry", () => {
    setChannelConfig(CHAN, { allowedMcps: ["vault", "harness"] });
    const args = buildCodexMcpApprovalArgs(CHAN, tomlPath);
    assert.deepEqual(args, [
      "-c", 'mcp_servers.vault.default_tools_approval_mode="approve"',
      "-c", 'mcp_servers.harness.default_tools_approval_mode="approve"',
    ]);
  });

  it("drops allowlist entries not registered with codex (e.g. claude-only `codex` MCP)", () => {
    setChannelConfig(CHAN, { allowedMcps: ["vault", "codex", "linkedin"] });
    const args = buildCodexMcpApprovalArgs(CHAN, tomlPath);
    assert.deepEqual(args, [
      "-c", 'mcp_servers.vault.default_tools_approval_mode="approve"',
    ]);
  });

  it("falls back to DEFAULT_MCP_BASELINE when channel has no allowlist", () => {
    clearChannelConfig(CHAN);
    const args = buildCodexMcpApprovalArgs(CHAN, tomlPath);
    // Default baseline includes vault/harness/projects/codex; only the
    // first three are codex-registered, and `codex` (Claude wrapper MCP)
    // is dropped.
    const flags = args.filter((a, i) => i % 2 === 1);
    assert.deepEqual(flags, [
      'mcp_servers.vault.default_tools_approval_mode="approve"',
      'mcp_servers.harness.default_tools_approval_mode="approve"',
      'mcp_servers.projects.default_tools_approval_mode="approve"',
    ]);
  });

  it("returns [] when codex config.toml is missing", () => {
    setChannelConfig(CHAN, { allowedMcps: ["vault"] });
    const args = buildCodexMcpApprovalArgs(CHAN, join(fixtureDir, "does-not-exist.toml"));
    assert.deepEqual(args, []);
  });
});

describe("recordCodexResult — telemetry parsing for Codex JSONL", () => {
  const TASK_ID = "test-codex-record-1";

  before(async () => {
    const { registerInstance } = await import("../instance-monitor.js");
    registerInstance({
      taskId: TASK_ID,
      channelId: "chan-1",
      agent: "researcher",
      runtime: "codex",
      prompt: "test",
      pid: 9999,
    });
  });

  after(async () => {
    const { finalizeInstance } = await import("../instance-monitor.js");
    finalizeInstance(TASK_ID, "completed");
  });

  it("counts mcp_tool_call events with namespaced tool name", async () => {
    const { recordCodexResult, getCompletedSummary } = await import("../instance-monitor.js");
    const jsonl = [
      JSON.stringify({ type: "thread.started", thread_id: "t-1" }),
      JSON.stringify({ type: "turn.started" }),
      JSON.stringify({
        type: "item.completed",
        item: {
          id: "i-1",
          type: "mcp_tool_call",
          server: "vault",
          tool: "vault_search",
          arguments: { query: "GraphN" },
          result: { content: [{ type: "text", text: "results..." }] },
          status: "completed",
        },
      }),
      JSON.stringify({
        type: "item.completed",
        item: {
          id: "i-2",
          type: "command_execution",
          command: "ls -la",
          exit_code: 0,
          output: "total 12",
        },
      }),
      JSON.stringify({
        type: "item.completed",
        item: { id: "i-3", type: "agent_message", text: "Found 3 results." },
      }),
      JSON.stringify({ type: "turn.completed", usage: { input_tokens: 1234, output_tokens: 56 } }),
    ].join("\n");

    recordCodexResult(TASK_ID, jsonl);

    const summary = getCompletedSummary(TASK_ID);
    assert.ok(summary, "summary present");
    assert.equal(summary!.totalTools, 2, "mcp_tool_call + command_execution counted");

    const names = summary!.toolCalls.map((t) => t.toolName);
    assert.deepEqual(names, ["mcp__vault__vault_search", "Bash"]);

    assert.equal(summary!.estInputTokens, 1234, "usage.input_tokens overrides text-length estimate");
    assert.equal(summary!.estOutputTokens, 56, "usage.output_tokens overrides text-length estimate");
  });

  it("captures mcp_tool_call errors in resultPreview", async () => {
    const { recordCodexResult, getCompletedSummary } = await import("../instance-monitor.js");
    const jsonl = JSON.stringify({
      type: "item.completed",
      item: {
        id: "i-x",
        type: "mcp_tool_call",
        server: "vault",
        tool: "vault_stats",
        arguments: {},
        result: null,
        error: { message: "user cancelled MCP tool call" },
        status: "failed",
      },
    });

    recordCodexResult(TASK_ID, jsonl);

    const summary = getCompletedSummary(TASK_ID);
    const last = summary!.toolCalls[summary!.toolCalls.length - 1]!;
    assert.equal(last.toolName, "mcp__vault__vault_stats");
    assert.match(last.resultPreview || "", /Error: user cancelled/);
  });

  it("ignores non-JSON and unknown event types without throwing", async () => {
    const { recordCodexResult } = await import("../instance-monitor.js");
    const jsonl = [
      "",
      "not json at all",
      JSON.stringify({ type: "totally.unknown.event", payload: { foo: 1 } }),
      JSON.stringify({ type: "item.completed", item: { type: "reasoning", text: "thinking..." } }),
    ].join("\n");
    assert.doesNotThrow(() => recordCodexResult(TASK_ID, jsonl));
  });
});
