import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { getDb } from "../db.js";
import { setChannelConfig } from "../channel-config-store.js";
import { buildPostChainGateRequests, resolveHandoffRuntime, type ChainEntry } from "../handoff-router.js";

function cleanupChannel(channelId: string): void {
  const db = getDb();
  db.prepare("DELETE FROM channel_configs WHERE channel_id = ?").run(channelId);
}

describe("Handoff Router — Post-chain Gates", () => {
  it("keeps builder output as the canonical artifact for reviewer and tester gates", () => {
    const chainEntries: ChainEntry[] = [
      {
        agent: "builder",
        response: "Builder changed src/app.ts and added tests.",
        timestamp: Date.now(),
      },
    ];

    const requests = buildPostChainGateRequests(chainEntries, ["builder", "reviewer", "tester"]);

    assert.equal(requests.length, 2);
    assert.equal(requests[0].gateAgent, "reviewer");
    assert.equal(requests[1].gateAgent, "tester");
    assert.equal(requests[0].fromAgent, "builder");
    assert.equal(requests[1].fromAgent, "builder");
    assert.ok(requests[0].prompt.includes("Builder changed src/app.ts"));
    assert.ok(requests[1].prompt.includes("Builder changed src/app.ts"));
    assert.ok(!requests[1].prompt.includes("reviewer"));
  });

  it("skips unavailable or already-participating gate agents", () => {
    const chainEntries: ChainEntry[] = [
      {
        agent: "builder",
        response: "Builder output",
        timestamp: Date.now(),
      },
      {
        agent: "reviewer",
        response: "Reviewer notes",
        timestamp: Date.now(),
      },
    ];

    const requests = buildPostChainGateRequests(chainEntries, ["builder", "reviewer"]);
    assert.equal(requests.length, 0);
  });
});

describe("Handoff Router — Runtime Resolution", () => {
  it("uses channel runtime override when present", () => {
    const channelId = "handoff-runtime-override";
    setChannelConfig(channelId, { runtime: "codex" });

    assert.equal(resolveHandoffRuntime(channelId, "reviewer"), "codex");
    cleanupChannel(channelId);
  });

  it("falls back to agent runtime metadata when no channel override exists", () => {
    assert.equal(resolveHandoffRuntime("handoff-runtime-agent", "codex-builder"), "codex");
    assert.equal(resolveHandoffRuntime("handoff-runtime-agent", "reviewer"), "claude");
  });
});
