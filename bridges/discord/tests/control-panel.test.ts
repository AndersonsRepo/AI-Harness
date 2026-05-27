import { after, afterEach, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  getAutorunMode,
  isAutonomousPaused,
  isFullyFrozen,
  setAutorunMode,
  setAutorunModeFileForTests,
} from "../autorun-mode.js";
import {
  buildChannelConfigPanel,
  buildControlPanel,
  handleControlInteraction,
  listHeartbeats,
  setControlKillForTests,
  toggleHeartbeat,
} from "../control-panel.js";
import { clearChannelConfig, getChannelConfig, setChannelConfig } from "../channel-config-store.js";

const HARNESS_ROOT = process.env.HARNESS_ROOT || ".";

// SAFETY: redirect the autorun flag to a temp file and stub the kill ops, so
// these tests never freeze the live bot or terminate real task/subagent PIDs
// (they otherwise run against the live HARNESS_ROOT + DB).
let tmpModeFile: string;
before(() => {
  tmpModeFile = join(mkdtempSync(join(tmpdir(), "cp-test-")), ".autorun-mode");
  setAutorunModeFileForTests(tmpModeFile);
  setControlKillForTests({ cancelChannelTasks: () => 0, cancelSubagent: () => false });
});
after(() => {
  setAutorunModeFileForTests(null);
  setControlKillForTests(null);
});

describe("autorun-mode kill-switch", () => {
  afterEach(() => setAutorunMode("normal"));

  it("defaults to normal with no flag file", () => {
    setAutorunMode("normal");
    assert.equal(getAutorunMode(), "normal");
    assert.equal(isAutonomousPaused(), false);
    assert.equal(isFullyFrozen(), false);
  });

  it("autonomous pauses autonomous AI but is not a full freeze", () => {
    setAutorunMode("autonomous");
    assert.equal(getAutorunMode(), "autonomous");
    assert.equal(isAutonomousPaused(), true);
    assert.equal(isFullyFrozen(), false);
  });

  it("full freeze pauses autonomous AND direct chat", () => {
    setAutorunMode("full");
    assert.equal(isAutonomousPaused(), true);
    assert.equal(isFullyFrozen(), true);
  });

  it("resuming to normal removes the flag file", () => {
    setAutorunMode("full");
    setAutorunMode("normal");
    assert.equal(existsSync(tmpModeFile), false);
    assert.equal(getAutorunMode(), "normal");
  });
});

describe("control-panel heartbeat toggle", () => {
  const TEMP = "_cp-test-heartbeat";
  const cfgPath = join(HARNESS_ROOT, "heartbeat-tasks", `${TEMP}.json`);
  const statePath = join(HARNESS_ROOT, "heartbeat-tasks", `${TEMP}.state.json`);

  afterEach(() => {
    for (const p of [cfgPath, statePath]) if (existsSync(p)) rmSync(p);
  });

  it("lists heartbeats with name/enabled/isAI shape", () => {
    const list = listHeartbeats();
    assert.ok(Array.isArray(list));
    for (const h of list.slice(0, 3)) {
      assert.equal(typeof h.name, "string");
      assert.equal(typeof h.enabled, "boolean");
      assert.equal(typeof h.isAI, "boolean");
    }
  });

  it("toggles a heartbeat's enabled flag in its config", () => {
    writeFileSync(
      cfgPath,
      JSON.stringify({ name: TEMP, type: "claude", prompt: "x", schedule: "12h", enabled: true }, null, 2),
    );
    assert.equal(toggleHeartbeat(TEMP, false), true);
    assert.equal(listHeartbeats().find((h) => h.name === TEMP)?.enabled, false);
    assert.equal(toggleHeartbeat(TEMP, true), true);
    assert.equal(listHeartbeats().find((h) => h.name === TEMP)?.enabled, true);
  });

  it("returns false for an unknown heartbeat (no mutation)", () => {
    assert.equal(toggleHeartbeat("does-not-exist-cp", false), false);
  });
});

describe("control-panel rendering", () => {
  afterEach(() => setAutorunMode("normal"));

  it("builds a panel with the title and at least the two button rows", () => {
    const panel = buildControlPanel();
    assert.ok(panel.content.includes("AI Harness Control Panel"));
    assert.ok(panel.components.length >= 2);
  });

  it("reflects the current autorun mode in the content", () => {
    setAutorunMode("full");
    assert.match(buildControlPanel().content, /Full freeze/i);
  });

  it("includes the status dashboard + real usage section (not the old rejection counter)", () => {
    const content = buildControlPanel().content;
    assert.match(content, /\*\*Status\*\*/);
    assert.match(content, /running tasks:/);
    assert.match(content, /dead-letter:/);
    assert.match(content, /render:/);
    assert.match(content, /Claude usage limits/);
    assert.doesNotMatch(content, /× today/); // old rejection-counter line is gone
  });
});

describe("control-panel interaction routing (deterministic, no AI)", () => {
  afterEach(() => setAutorunMode("normal"));

  const mockClient = { channels: { cache: { get: (_id: string) => ({ name: "test-channel" }) } } };

  function buttonInteraction(customId: string) {
    const calls: Record<string, any> = {};
    return {
      _calls: calls,
      isButton: () => true,
      isStringSelectMenu: () => false,
      customId,
      client: mockClient,
      update: async (payload: any) => { calls.update = payload; },
      reply: async (payload: any) => { calls.reply = payload; },
      followUp: async (payload: any) => { calls.followUp = payload; },
      message: { edit: async (payload: any) => { calls.edit = payload; } },
    };
  }

  function selectInteraction(customId: string, values: string[]) {
    const calls: Record<string, any> = {};
    return {
      _calls: calls,
      isButton: () => false,
      isStringSelectMenu: () => true,
      customId,
      values,
      client: mockClient,
      update: async (payload: any) => { calls.update = payload; },
      reply: async (payload: any) => { calls.reply = payload; },
      followUp: async (payload: any) => { calls.followUp = payload; },
    };
  }

  it("autorun:full button sets full freeze and refreshes the panel in place", async () => {
    const i = buttonInteraction("control:autorun:full");
    const handled = await handleControlInteraction(i as any);
    assert.equal(handled, true);
    assert.equal(getAutorunMode(), "full");
    assert.ok(i._calls.update, "panel updated in place");
  });

  it("autorun:normal button resumes", async () => {
    setAutorunMode("full");
    const i = buttonInteraction("control:autorun:normal");
    await handleControlInteraction(i as any);
    assert.equal(getAutorunMode(), "normal");
  });

  it("reap button replies ephemerally and never updates mode", async () => {
    const i = buttonInteraction("control:reap");
    await handleControlInteraction(i as any);
    assert.ok(i._calls.reply, "ephemeral reply with reap report");
    assert.equal(getAutorunMode(), "normal");
  });

  it("ignores non-control interactions", async () => {
    const i = buttonInteraction("monitor:kill:task-1");
    assert.equal(await handleControlInteraction(i as any), false);
  });

  it("Agent Activity button replies ephemerally without spawning AI", async () => {
    const i = buttonInteraction("control:activity");
    assert.equal(await handleControlInteraction(i as any), true);
    assert.ok(i._calls.reply, "activity replied");
    assert.equal(getAutorunMode(), "normal");
  });

  it("Kill ALL button replies with a cancellation count and refreshes", async () => {
    const i = buttonInteraction("control:kill-all");
    assert.equal(await handleControlInteraction(i as any), true);
    assert.ok(i._calls.reply, "kill-all replied");
    assert.match(i._calls.reply.content, /Cancelled/i);
  });

  it("kill-channel select is handled and follows up", async () => {
    const i = selectInteraction("control:kill-channel", ["some-channel-id"]);
    assert.equal(await handleControlInteraction(i as any), true);
    assert.ok(i._calls.update, "panel refreshed");
    assert.ok(i._calls.followUp, "kill result followed up");
  });
});

describe("control-panel — channel configuration (runtime + agent)", () => {
  // Fake channel id so setChannelConfig never touches a real channel's settings.
  const CHAN = "cfg-panel-test-channel";
  const mockClient = { channels: { cache: { get: () => ({ name: "cfg-test" }) } } };

  function cfgSelect(customId: string, values: string[]) {
    const calls: Record<string, any> = {};
    return {
      _calls: calls,
      isButton: () => false,
      isStringSelectMenu: () => true,
      customId,
      values,
      client: mockClient,
      update: async (p: any) => { calls.update = p; },
      reply: async (p: any) => { calls.reply = p; },
      followUp: async (p: any) => { calls.followUp = p; },
      deferUpdate: async () => { calls.deferUpdate = true; },
    };
  }

  afterEach(() => clearChannelConfig(CHAN));

  it("builds a config panel with three selects (channel, runtime, agent)", () => {
    setChannelConfig(CHAN, { agent: "builder", runtime: "claude" });
    const panel = buildChannelConfigPanel({ selectedChannelId: CHAN });
    assert.match(panel.content, /Channel Configuration/);
    assert.equal(panel.components.length, 3);
  });

  it("cfg-channel select refreshes the config panel in place", async () => {
    setChannelConfig(CHAN, { agent: "builder", runtime: "claude" });
    const i = cfgSelect("control:cfg-channel", [CHAN]);
    assert.equal(await handleControlInteraction(i as any), true);
    assert.ok(i._calls.update, "config panel refreshed with selection");
  });

  it("cfg-runtime applies the runtime to the embedded channel", async () => {
    setChannelConfig(CHAN, { runtime: "claude" });
    const i = cfgSelect(`control:cfg-runtime:${CHAN}`, ["codex"]);
    assert.equal(await handleControlInteraction(i as any), true);
    assert.equal(getChannelConfig(CHAN)?.runtime, "codex");
    assert.ok(i._calls.followUp, "confirmation sent");
  });

  it("cfg-agent applies the agent (personality) to the embedded channel", async () => {
    setChannelConfig(CHAN, { agent: "builder" });
    const i = cfgSelect(`control:cfg-agent:${CHAN}`, ["researcher"]);
    assert.equal(await handleControlInteraction(i as any), true);
    assert.equal(getChannelConfig(CHAN)?.agent, "researcher");
  });

  it("cfg-runtime with no channel embedded prompts to pick one (no mutation)", async () => {
    const i = cfgSelect("control:cfg-runtime:", ["codex"]);
    assert.equal(await handleControlInteraction(i as any), true);
    assert.ok(i._calls.reply, "prompted to pick a channel");
    assert.ok(!getChannelConfig(CHAN), "no config row created for the empty-channel case");
  });
});
