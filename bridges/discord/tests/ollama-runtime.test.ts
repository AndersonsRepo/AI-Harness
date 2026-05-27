// Phase H — the third runtime (local Ollama). Session-less, tool-less, HTTP.
// Verifies the adapter is registered with honest capabilities, parses its
// runner envelope, renders a system+user payload file pointing at
// local-runner.py, and is OPT-IN in role-policy (never auto-fallback).
//
// No model is downloaded and no spawn happens here — purely the adapter/policy
// contract. The live quality comparison (validation slice) is deferred until
// the model is pulled.

import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync, mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { getAdapter } from "../runtime-adapter.js";
import { buildAgentContext } from "../agent-context.js";
import { extractOllamaResponse } from "../ollama-config.js";
import { resolveRuntimePolicy } from "../role-policy.js";
import { clearChannelConfig, setChannelConfig } from "../channel-config-store.js";

const CHANNEL = "ollama-runtime-test";

describe("ollama adapter (Phase H local runtime)", () => {
  const ollama = getAdapter("ollama");

  afterEach(() => clearChannelConfig(CHANNEL));

  it("is registered with honest session-less capabilities", () => {
    assert.equal(ollama.tag, "ollama");
    assert.equal(ollama.capabilities.sessionResume, false);
    assert.equal(ollama.capabilities.continuation, false);
    assert.equal(ollama.capabilities.streamingTelemetry, false);
    assert.equal(ollama.capabilities.loopDetection, false);
  });

  it("extractResponse prefers lastMessage, falls back to stdout, null on failure", () => {
    assert.equal(extractOllamaResponse({ stdout: "x", lastMessage: "hello" } as any), "hello");
    assert.equal(extractOllamaResponse({ stdout: "from stdout" } as any), "from stdout");
    assert.equal(extractOllamaResponse({ stdout: "", stderr: "boom", returncode: 1 } as any), null);
  });

  it("session-less hooks: no session id, never stale, no tool signatures", () => {
    assert.equal(ollama.extractSessionId({ stdout: "" } as any), null);
    assert.equal(ollama.isStaleSessionError({ stderr: "session not found" } as any), false);
    assert.deepEqual(ollama.parseToolCallSignatures({ stdout: "{}" } as any), []);
  });

  it("renderContext spawns local-runner.py and writes a system+user payload file", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ollama-test-"));
    const promptFilePath = join(dir, "payload.json");
    const outputFile = join(dir, "out.json");
    try {
      const context = buildAgentContext({
        channelId: CHANNEL,
        agentName: null,
        prompt: "What is 2+2?",
        sessionKey: CHANNEL,
        runtime: "ollama",
        workflow: { kind: "chat", taskId: "ollama-test-task" },
      });
      const args = await ollama.renderContext!(context, { outputFile, promptFilePath });

      assert.equal(args.pythonArgs[0]?.endsWith("local-runner.py"), true);
      assert.ok(args.pythonArgs.includes("--payload-file"));
      assert.ok(existsSync(promptFilePath), "payload file written");

      const payload = JSON.parse(readFileSync(promptFilePath, "utf-8"));
      assert.equal(payload.user, "What is 2+2?");
      assert.equal(typeof payload.system, "string");
      assert.ok(payload.model, "model set");
      assert.ok(String(payload.endpoint).startsWith("http"), "endpoint set");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("role-policy: ollama is opt-in (selectable explicitly + per-channel, NOT auto-fallback)", () => {
    const explicit = resolveRuntimePolicy({ channelId: CHANNEL, explicitRuntime: "ollama" });
    assert.equal(explicit.selectedRuntime, "ollama");

    setChannelConfig(CHANNEL, { runtime: "ollama" });
    const chan = resolveRuntimePolicy({ channelId: CHANNEL });
    assert.equal(chan.selectedRuntime, "ollama");

    clearChannelConfig(CHANNEL);
    const def = resolveRuntimePolicy({ channelId: "ollama-runtime-test-noconfig" });
    assert.equal(def.fallbackOrder.includes("ollama"), false, "ollama must never auto-fallback");
  });
});
