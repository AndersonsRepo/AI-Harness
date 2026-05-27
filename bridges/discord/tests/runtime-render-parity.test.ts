import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { getAdapter } from "../runtime-adapter.js";
import { buildAgentContext } from "../agent-context.js";
import { buildCodexConfig, buildCodexConfigFromContext } from "../codex-config.js";
import { clearChannelConfig, setChannelConfig } from "../channel-config-store.js";
import { clearSession } from "../session-store.js";
import { deleteProject } from "../project-manager.js";

/**
 * Phase B parity gate (Claude).
 *
 * Proves the NEW path — `claudeAdapter.renderContext(buildAgentContext(...))` —
 * produces byte-identical SpawnArgs to the LEGACY path
 * `claudeAdapter.buildSpawnArgs(...)` for equivalent inputs. The comparison
 * axis is old-vs-new within the Claude runtime ("did we change behavior?"),
 * NOT Claude-vs-Codex.
 *
 * The three nondeterminism landmines from the close-look are neutralized:
 *  - MCP config path (`harness-mcp-${taskId}.json`): fixed taskId → same path.
 *  - getSession 24h gate: fresh channels (cleared session) → no --resume.
 *  - agent-name divergence: general-chat shapes only (explicit agent or the
 *    "default" sentinel; non-project channels), where profile.name equals
 *    legacy's `opts.agentName || channelConfig.agent`.
 */

const claude = getAdapter("claude");
const TASK_ID = "render-parity-fixed-task";
const OUTPUT_FILE = "/tmp/render-parity-output.json";

interface Cell {
  channelId: string;
  agentName: string | null; // explicit agent (null = plain general chat → "default")
  channelModel?: string; // channelConfig.model override
  channelName?: string | null;
  prompt?: string;
  isContinuation?: boolean;
  extraSystemPrompts?: string[];
  streamDir?: string;
  timeoutSecs?: number;
}

const channelsToCleanup = new Set<string>();

async function assertParity(cell: Cell): Promise<void> {
  channelsToCleanup.add(cell.channelId);
  clearSession(cell.channelId, "claude"); // fresh → no --resume in either path
  if (cell.channelModel) {
    setChannelConfig(cell.channelId, { model: cell.channelModel });
  }

  const prompt = cell.prompt ?? "Do the next focused task.";
  const channelName = cell.channelName ?? null;

  const legacy = await claude.buildSpawnArgs({
    channelId: cell.channelId,
    channelName,
    prompt,
    agentName: cell.agentName,
    taskId: TASK_ID,
    outputFile: OUTPUT_FILE,
    sessionKey: cell.channelId,
    skipSessionResume: false,
    streamDir: cell.streamDir,
    timeoutSecs: cell.timeoutSecs,
    isContinuation: cell.isContinuation,
    extraSystemPrompts: cell.extraSystemPrompts,
    worktreePath: null,
  });

  const context = buildAgentContext({
    channelId: cell.channelId,
    channelName,
    agentName: cell.agentName,
    prompt,
    sessionKey: cell.channelId,
    runtime: "claude",
    workflow: {
      kind: "task",
      taskId: TASK_ID,
      isContinuation: cell.isContinuation,
      worktreePath: null,
      skipSessionResume: false,
    },
    extraSystemPrompts: cell.extraSystemPrompts,
  });
  const rendered = await claude.renderContext!(context, {
    outputFile: OUTPUT_FILE,
    streamDir: cell.streamDir,
    timeoutSecs: cell.timeoutSecs,
  });

  assert.deepEqual(rendered, legacy);
}

describe("Claude renderContext parity (Phase B)", () => {
  afterEach(() => {
    for (const id of channelsToCleanup) {
      clearChannelConfig(id);
      deleteProject(id);
      clearSession(id, "claude");
    }
    channelsToCleanup.clear();
  });

  // Agent variation — covers per-agent prompt, model default, tool restrictions.
  for (const agent of ["builder", "researcher", "education", "ops", "orchestrator", "reviewer"]) {
    it(`matches legacy for agent=${agent}`, async () => {
      await assertParity({ channelId: `render-parity-${agent}`, agentName: agent });
    });
  }

  it("matches legacy with a channel model override", async () => {
    await assertParity({
      channelId: "render-parity-model",
      agentName: "builder",
      channelModel: "opus",
    });
  });

  it("matches legacy when channel model overrides an agent default", async () => {
    await assertParity({
      channelId: "render-parity-model-override",
      agentName: "orchestrator", // agent-default opus → overridden by channel sonnet
      channelModel: "sonnet",
    });
  });

  it("matches legacy in continuation mode", async () => {
    await assertParity({
      channelId: "render-parity-cont",
      agentName: "builder",
      isContinuation: true,
    });
  });

  it("matches legacy with extra system prompts", async () => {
    await assertParity({
      channelId: "render-parity-extra",
      agentName: "builder",
      extraSystemPrompts: ["Intervention: keep it short.", "Note: cite files."],
    });
  });

  it("matches legacy with a channel name (HARNESS_CHANNEL_NAME)", async () => {
    await assertParity({
      channelId: "render-parity-chname",
      agentName: "builder",
      channelName: "general",
    });
  });

  it("matches legacy with stream dir + timeout", async () => {
    await assertParity({
      channelId: "render-parity-stream",
      agentName: "builder",
      streamDir: "/tmp/render-parity-stream",
      timeoutSecs: 300,
    });
  });

  it("matches legacy for plain general chat (no agent → 'default' sentinel)", async () => {
    // The most common general-chat shape: no explicit agent, no channel agent.
    // effectiveAgentName → "default"; with no default.md and no default
    // model/tool entries this is byte-identical to legacy's undefined agent.
    await assertParity({ channelId: "render-parity-default", agentName: null });
  });
});

describe("Codex renderContext parity (Phase C)", () => {
  const codex = getAdapter("codex");
  const codexChannels = new Set<string>();

  afterEach(() => {
    for (const id of codexChannels) {
      clearChannelConfig(id);
      deleteProject(id);
      clearSession(id, "codex");
    }
    codexChannels.clear();
  });

  // Config-level parity: compares the full CodexRunConfig (composed prompt,
  // runnerArgs incl. sandbox + MCP-approval, env incl. safety patterns/tool
  // policy, cwd). SpawnArgs only carries the prompt-file PATH, so a prompt
  // divergence would slip past a SpawnArgs-only compare — hence config-level.
  async function assertCodexConfigParity(cell: Cell): Promise<void> {
    codexChannels.add(cell.channelId);
    clearSession(cell.channelId, "codex");
    const prompt = cell.prompt ?? "Do the next focused task.";
    const channelName = cell.channelName ?? null;

    const legacy = await buildCodexConfig({
      channelId: cell.channelId,
      channelName,
      prompt,
      agentName: cell.agentName,
      sessionKey: cell.channelId,
      taskId: TASK_ID,
      extraSystemPrompts: cell.extraSystemPrompts,
      worktreePath: null,
      skipSessionResume: false,
      isContinuation: cell.isContinuation,
    });

    const context = buildAgentContext({
      channelId: cell.channelId,
      channelName,
      agentName: cell.agentName,
      prompt,
      sessionKey: cell.channelId,
      runtime: "codex",
      workflow: {
        kind: "task",
        taskId: TASK_ID,
        isContinuation: cell.isContinuation,
        worktreePath: null,
        skipSessionResume: false,
      },
      extraSystemPrompts: cell.extraSystemPrompts,
    });
    const rendered = await buildCodexConfigFromContext(context);

    assert.deepEqual(rendered, legacy);
  }

  // Agent sweep — also exercises sandbox variation (read-only for
  // orchestrator/researcher/reviewer/education; write for builder/ops) and
  // per-agent tool policy in CODEX_TOOL_POLICY.
  for (const agent of ["builder", "researcher", "education", "ops", "orchestrator", "reviewer"]) {
    it(`matches legacy CodexRunConfig for agent=${agent}`, async () => {
      await assertCodexConfigParity({ channelId: `render-parity-codex-${agent}`, agentName: agent });
    });
  }

  it("matches legacy CodexRunConfig in continuation mode", async () => {
    await assertCodexConfigParity({
      channelId: "render-parity-codex-cont",
      agentName: "builder",
      isContinuation: true,
    });
  });

  it("matches legacy CodexRunConfig with extra system prompts", async () => {
    await assertCodexConfigParity({
      channelId: "render-parity-codex-extra",
      agentName: "builder",
      extraSystemPrompts: ["Intervention: keep it short.", "Note: cite files."],
    });
  });

  it("matches legacy CodexRunConfig with a channel name", async () => {
    await assertCodexConfigParity({
      channelId: "render-parity-codex-chname",
      agentName: "builder",
      channelName: "general",
    });
  });

  it("matches legacy CodexRunConfig for plain general chat (default sentinel)", async () => {
    await assertCodexConfigParity({ channelId: "render-parity-codex-default", agentName: null });
  });

  // SpawnArgs-level: proves wrapCodexSpawnArgs (prompt-file write + runner argv)
  // matches buildSpawnArgs end-to-end, with a fixed prompt-file path.
  it("renderContext SpawnArgs match buildSpawnArgs (with prompt file)", async () => {
    const channelId = "render-parity-codex-spawn";
    codexChannels.add(channelId);
    clearSession(channelId, "codex");
    const PROMPT_FILE = "/tmp/render-parity-codex-prompt.txt";
    const STREAM_DIR = "/tmp/render-parity-codex-stream";

    const legacy = await codex.buildSpawnArgs({
      channelId,
      channelName: "general",
      prompt: "Do the next focused task.",
      agentName: "builder",
      taskId: TASK_ID,
      outputFile: OUTPUT_FILE,
      sessionKey: channelId,
      skipSessionResume: false,
      streamDir: STREAM_DIR,
      timeoutSecs: 300,
      promptFilePath: PROMPT_FILE,
    });

    const context = buildAgentContext({
      channelId,
      channelName: "general",
      agentName: "builder",
      prompt: "Do the next focused task.",
      sessionKey: channelId,
      runtime: "codex",
      workflow: { kind: "task", taskId: TASK_ID, worktreePath: null, skipSessionResume: false },
    });
    const rendered = await codex.renderContext!(context, {
      outputFile: OUTPUT_FILE,
      streamDir: STREAM_DIR,
      timeoutSecs: 300,
      promptFilePath: PROMPT_FILE,
    });

    assert.deepEqual(rendered, legacy);
  });
});
