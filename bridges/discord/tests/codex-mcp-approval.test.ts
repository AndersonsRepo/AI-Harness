import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const harnessRoot = mkdtempSync(join(tmpdir(), "aih-codex-mcp-"));
mkdirSync(join(harnessRoot, "bridges", "discord"), { recursive: true });
process.env.HARNESS_ROOT = harnessRoot;

const { setChannelConfig, clearChannelConfig } = await import("../channel-config-store.js");
const { buildCodexMcpApprovalArgs, buildCodexHarnessEnvArgs } = await import("../codex-config.js");

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

describe("buildCodexHarnessEnvArgs — propagate HARNESS_* env into harness MCP subprocess", () => {
  // ERR-20260430-001: Codex doesn't inherit parent env into MCP subprocesses.
  // Without these -c overrides, harness_handoff (and any future tool that
  // reads HARNESS_* env vars) errors out under Codex.
  //
  // Owns its own fixture dir because the previous describe block's after()
  // hook wipes the shared one before this block runs.

  const myFixtureDir = mkdtempSync(join(tmpdir(), "aih-codex-env-toml-"));
  const myTomlPath = join(myFixtureDir, "config.toml");
  writeFileSync(
    myTomlPath,
    [
      'model = "gpt-5.4"',
      "",
      "[mcp_servers.vault]",
      'command = "node"',
      "",
      "[mcp_servers.harness]",
      'command = "node"',
      "",
    ].join("\n"),
  );

  after(() => {
    rmSync(myFixtureDir, { recursive: true, force: true });
  });

  it("emits three -c overrides when harness MCP is registered", () => {
    const args = buildCodexHarnessEnvArgs({
      channelId: "1499234537090322443",
      sessionKey: "1499234537090322443:orchestrator",
      fromAgent: "orchestrator",
      registryPath: myTomlPath,
    });
    assert.deepEqual(args, [
      "-c", 'mcp_servers.harness.env.HARNESS_CHANNEL_ID="1499234537090322443"',
      "-c", 'mcp_servers.harness.env.HARNESS_SESSION_KEY="1499234537090322443:orchestrator"',
      "-c", 'mcp_servers.harness.env.HARNESS_FROM_AGENT="orchestrator"',
    ]);
  });

  it("returns [] when the harness MCP server is not registered with codex", () => {
    const noHarnessToml = join(myFixtureDir, "no-harness.toml");
    writeFileSync(
      noHarnessToml,
      'model = "gpt-5.4"\n\n[mcp_servers.vault]\ncommand = "node"\n',
    );
    const args = buildCodexHarnessEnvArgs({
      channelId: "abc",
      sessionKey: "abc:orchestrator",
      fromAgent: "orchestrator",
      registryPath: noHarnessToml,
    });
    assert.deepEqual(args, []);
  });

  it("escapes embedded double quotes in values", () => {
    // Defensive: real-world values won't contain `"` (digits + colon + agent
    // name from a fixed roster) but the helper should still produce a valid
    // TOML string literal if the call sites widen.
    const args = buildCodexHarnessEnvArgs({
      channelId: 'weird"chan',
      sessionKey: "session",
      fromAgent: "agent",
      registryPath: myTomlPath,
    });
    assert.equal(args[1], 'mcp_servers.harness.env.HARNESS_CHANNEL_ID="weird\\"chan"');
  });

  it("returns [] when codex config.toml is missing", () => {
    const args = buildCodexHarnessEnvArgs({
      channelId: "abc",
      sessionKey: "abc:orchestrator",
      fromAgent: "orchestrator",
      registryPath: join(myFixtureDir, "does-not-exist.toml"),
    });
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

describe("estimateCostCents — runtime-branched pricing in getCompletedSummary", () => {
  // Each test gets a fresh task_id so cost assertions don't bleed across cases.
  // Phase 0 cost-capture (D3.1 plan): Codex spawns must be priced at GPT-5.4
  // rates, not Sonnet — prior to this branch, telemetry over-reported Codex
  // by ~2.4×.

  async function runOne(opts: {
    taskId: string;
    runtime: "claude" | "codex";
    inputTokens: number;
    outputTokens: number;
    cachedInputTokens?: number;
  }) {
    const { registerInstance, recordCodexResult, getCompletedSummary, finalizeInstance } =
      await import("../instance-monitor.js");
    registerInstance({
      taskId: opts.taskId,
      channelId: "chan-cost",
      agent: "researcher",
      runtime: opts.runtime,
      prompt: "test",
      pid: 9999,
    });

    if (opts.runtime === "codex") {
      // For Codex, drive token counts through the JSONL parser so we exercise
      // the same code path the runtime actually uses in production.
      const usage: Record<string, number> = {
        input_tokens: opts.inputTokens,
        output_tokens: opts.outputTokens,
      };
      if (typeof opts.cachedInputTokens === "number") {
        usage.cached_input_tokens = opts.cachedInputTokens;
      }
      recordCodexResult(opts.taskId, JSON.stringify({ type: "turn.completed", usage }));
    } else {
      // For Claude, the production path mutates estimatedInputTokens via
      // stream-json events; for this unit test we set the counts directly
      // using the registry. Reach into the Map the same way the production
      // code does.
      const { getInstance } = await import("../instance-monitor.js");
      const inst = getInstance(opts.taskId)!;
      inst.estimatedInputTokens = opts.inputTokens;
      inst.estimatedOutputTokens = opts.outputTokens;
    }

    const summary = getCompletedSummary(opts.taskId)!;
    finalizeInstance(opts.taskId, "completed");
    return summary;
  }

  it("Codex spawn uses GPT-5.4 pricing ($1.25/$10 per MTok), not Sonnet", async () => {
    // 100K input, 5K output
    // Codex: 100_000 * 1.25/M + 5_000 * 10/M = $0.125 + $0.05 = $0.175 = 17.5¢ → 18¢
    // (Sonnet would be: $0.30 + $0.075 = $0.375 = 37.5¢ → 38¢)
    const summary = await runOne({
      taskId: "cost-codex-no-cache",
      runtime: "codex",
      inputTokens: 100_000,
      outputTokens: 5_000,
    });
    assert.equal(summary.estCostCents, 18, "Codex pricing should yield ~18¢");
  });

  it("Codex cached_input_tokens are billed at the cached rate ($0.125/MTok), not full input rate", async () => {
    // 1M input total, 800K cached, 200K fresh, 100K output
    // Fresh:  200_000 * 1.25/M  = $0.25
    // Cached: 800_000 * 0.125/M = $0.10
    // Output: 100_000 * 10/M    = $1.00
    // Total: $1.35 = 135¢
    // (Without caching applied, total would be $2.25 = 225¢ — caching saves ~40%)
    const summary = await runOne({
      taskId: "cost-codex-cached",
      runtime: "codex",
      inputTokens: 1_000_000,
      cachedInputTokens: 800_000,
      outputTokens: 100_000,
    });
    assert.equal(summary.estCostCents, 135, "Cached portion should be priced at $0.125/MTok");
  });

  it("Claude spawn keeps Sonnet pricing ($3/$15 per MTok) — no regression from Codex branch", async () => {
    // Same shape as the Codex no-cache test, but Claude runtime.
    // 100_000 * 3/M + 5_000 * 15/M = $0.30 + $0.075 = $0.375 = 37.5¢ → 38¢
    const summary = await runOne({
      taskId: "cost-claude-baseline",
      runtime: "claude",
      inputTokens: 100_000,
      outputTokens: 5_000,
    });
    assert.equal(summary.estCostCents, 38, "Claude should still use Sonnet pricing");
  });

  it("malformed cached_input_tokens > input_tokens does not push fresh negative", async () => {
    // Defensive clamp: if a payload reports cached > input, fresh would go
    // negative without the Math.min guard, producing a credit. Guard ensures
    // cost is non-negative and the entire input is treated as cached.
    const summary = await runOne({
      taskId: "cost-codex-malformed-cache",
      runtime: "codex",
      inputTokens: 100,
      cachedInputTokens: 999_999,
      outputTokens: 0,
    });
    assert.ok(summary.estCostCents >= 0, "cost cents must not go negative on bad payload");
  });
});
