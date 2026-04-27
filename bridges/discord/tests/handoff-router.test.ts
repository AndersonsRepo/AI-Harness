import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { getDb } from "../db.js";
import { setChannelConfig } from "../channel-config-store.js";
import {
  buildPostChainGateRequests,
  resolveHandoffRuntime,
  executeChainCore,
  buildHandoffPrompt,
  dequeueHandoff,
  DiscordSink,
  NullSink,
  type AgentExecutor,
  type ChainEntry,
  type ChainSink,
  type ExecuteAgentArgs,
  type HandoffResult,
} from "../handoff-router.js";

function cleanupChannel(channelId: string): void {
  const db = getDb();
  db.prepare("DELETE FROM channel_configs WHERE channel_id = ?").run(channelId);
}

function cleanupHandoffQueue(sessionKey: string): void {
  const db = getDb();
  db.prepare("DELETE FROM handoff_queue WHERE session_key = ?").run(sessionKey);
}

function insertHandoffQueueRow(args: {
  sessionKey: string;
  channelId: string;
  fromAgent: string;
  targetAgent: string;
  taskDescription: string;
  preHandoffText?: string;
}): number {
  const db = getDb();
  const stmt = db.prepare(
    `INSERT INTO handoff_queue (session_key, channel_id, from_agent, target_agent, task_description, pre_handoff_text, status)
     VALUES (?, ?, ?, ?, ?, ?, 'pending')`,
  );
  const result = stmt.run(
    args.sessionKey,
    args.channelId,
    args.fromAgent,
    args.targetAgent,
    args.taskDescription,
    args.preHandoffText ?? "",
  );
  return Number(result.lastInsertRowid);
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

// Minimal TextChannel stub — captures send calls for assertion. Not all
// TextChannel methods are implemented; tests using this stub must only
// exercise paths that touch `id` and `send`. If a path under test reaches
// further into the channel surface, the test will throw and the stub
// should be expanded.
type CaptureSend = { content: string };
function makeFakeChannel(channelId: string, opts: { sendThrows?: Error } = {}) {
  const sends: CaptureSend[] = [];
  const channel = {
    id: channelId,
    send: async (content: string) => {
      if (opts.sendThrows) throw opts.sendThrows;
      sends.push({ content });
      return { id: `msg-${sends.length}` };
    },
    sendTyping: async () => {},
  } as any;
  return { channel, sends };
}

describe("Handoff Router — ChainSink Contract", () => {
  it("NullSink swallows every method without throwing", async () => {
    const sink: ChainSink = new NullSink();
    await sink.postPreHandoffText("builder", "anything");
    await sink.postAgentResponse("reviewer", "anything");
    await sink.postGateNotice("builder", "reviewer");
    await sink.postGateResponse("reviewer", "looks good");
    await sink.postWarning("oops");
    await sink.postDeliveryFailure("builder", "Discord 500");
    // Reaching this assertion is the test — none of the calls threw.
    assert.ok(true);
  });

  it("DiscordSink.postPreHandoffText is a no-op for empty text", async () => {
    const { channel, sends } = makeFakeChannel("test-sink-empty-pre");
    const sink = new DiscordSink(channel);
    await sink.postPreHandoffText("builder", "");
    assert.equal(sends.length, 0);
  });

  it("DiscordSink.postPreHandoffText labels the agent and posts via channel.send", async () => {
    const { channel, sends } = makeFakeChannel("test-sink-pre");
    const sink = new DiscordSink(channel);
    await sink.postPreHandoffText("builder", "wrote a fix");
    assert.equal(sends.length, 1);
    assert.ok(sends[0].content.startsWith("**Builder:**"));
    assert.ok(sends[0].content.includes("wrote a fix"));
  });

  it("DiscordSink.postAgentResponse throws when channel.send rejects (so chain catch fires)", async () => {
    const { channel } = makeFakeChannel("test-sink-throws", {
      sendThrows: new Error("Discord rate limited"),
    });
    const sink = new DiscordSink(channel);
    await assert.rejects(
      () => sink.postAgentResponse("reviewer", "looks good"),
      /Discord rate limited/,
    );
  });

  it("DiscordSink.postWarning swallows send errors silently", async () => {
    const { channel } = makeFakeChannel("test-sink-warning-throws", {
      sendThrows: new Error("Discord 500"),
    });
    const sink = new DiscordSink(channel);
    // Original code uses .catch(() => {}); preserved behavior here.
    await sink.postWarning("*Failed to start parallel tasks: foo*");
    assert.ok(true);
  });

  it("DiscordSink.postDeliveryFailure swallows send errors silently", async () => {
    const { channel } = makeFakeChannel("test-sink-delivery-throws", {
      sendThrows: new Error("Discord 500"),
    });
    const sink = new DiscordSink(channel);
    await sink.postDeliveryFailure("builder", "earlier error");
    assert.ok(true);
  });
});

// Programmable executor for chain-loop tests. Each call returns the next
// queued response (or throws if the queue is exhausted), and records every
// args object it received for assertion.
function makeFakeExecutor(responses: Array<HandoffResult | null>) {
  const calls: ExecuteAgentArgs[] = [];
  const queue = [...responses];
  const executor: AgentExecutor = {
    async execute(args: ExecuteAgentArgs): Promise<HandoffResult | null> {
      calls.push(args);
      if (queue.length === 0) {
        throw new Error("FakeAgentExecutor exhausted — chain made more calls than expected");
      }
      return queue.shift()!;
    },
  };
  return { executor, calls };
}

describe("Handoff Router — executeChainCore (no executor calls)", () => {
  it("records the initial agent's response (truncated to 2000 chars) when no handoff follows", async () => {
    const { executor, calls } = makeFakeExecutor([]);
    const sink = new NullSink();
    const longResponse = "x".repeat(3000);

    const result = await executeChainCore({
      channelId: "test-chain-no-handoff",
      sink,
      executor,
      initialAgent: "researcher",
      initialResponse: longResponse,
      originAgent: "researcher",
    });

    assert.equal(result.entries.length, 1);
    assert.equal(result.entries[0].agent, "researcher");
    assert.equal(result.entries[0].response.length, 2000);
    assert.equal(result.originAgent, "researcher");
    assert.equal(result.parallelGroupId, undefined);
    // No handoff means the loop never iterates — executor must not have been called.
    assert.equal(calls.length, 0);
  });

  it("preserves the originAgent passed by the caller", async () => {
    const { executor } = makeFakeExecutor([]);
    const sink = new NullSink();

    const result = await executeChainCore({
      channelId: "test-chain-origin",
      sink,
      executor,
      initialAgent: "researcher",
      initialResponse: "no handoff here",
      originAgent: "orchestrator",
    });

    assert.equal(result.originAgent, "orchestrator");
    assert.equal(result.entries[0].agent, "researcher");
  });
});

describe("Handoff Router — executeChainCore chain loop with injected executor", () => {
  it("walks a researcher → reviewer chain, recording each step", async () => {
    const { executor, calls } = makeFakeExecutor([
      { agentName: "reviewer", response: "Looks good. No issues found.", nextHandoff: null },
    ]);
    const sink = new NullSink();
    const initial = "Investigated the issue. Recommend reviewer take a look.\n\n[HANDOFF:reviewer] Please review my findings.";

    const result = await executeChainCore({
      channelId: "test-chain-two-step",
      sink,
      executor,
      initialAgent: "researcher",
      initialResponse: initial,
      originAgent: "researcher",
    });

    // 1 executor call (reviewer); 2 chain entries (researcher initial + reviewer)
    assert.equal(calls.length, 1);
    assert.equal(calls[0].fromAgent, "researcher");
    assert.equal(calls[0].toAgent, "reviewer");
    assert.equal(calls[0].handoffMessage, "Please review my findings.");
    assert.equal(result.entries.length, 2);
    assert.equal(result.entries[0].agent, "researcher");
    assert.equal(result.entries[1].agent, "reviewer");
    assert.equal(result.entries[1].response, "Looks good. No issues found.");
  });

  it("ends the chain immediately when the executor returns null", async () => {
    const { executor, calls } = makeFakeExecutor([null]);
    const sink = new NullSink();
    const initial = "Checking with the reviewer.\n\n[HANDOFF:reviewer] please look at this.";

    const result = await executeChainCore({
      channelId: "test-chain-executor-null",
      sink,
      executor,
      initialAgent: "researcher",
      initialResponse: initial,
      originAgent: "researcher",
    });

    // Executor was called once and returned null → loop breaks → only initial entry recorded
    assert.equal(calls.length, 1);
    assert.equal(result.entries.length, 1);
    assert.equal(result.entries[0].agent, "researcher");
  });

  it("threads chain context through each executor call (last entry, current task)", async () => {
    // Snapshot context at call time — the chainContext.completedPhases array
    // is passed by reference and accumulates after the call returns, so we
    // record what the agent would see at the moment it's invoked.
    const snapshots: Array<{ phaseAgents: string[]; currentTask: string | undefined }> = [];
    const queue: Array<HandoffResult | null> = [
      {
        agentName: "builder",
        response: "Made the change.\n\n[HANDOFF:reviewer] please verify.",
        nextHandoff: { targetAgent: "reviewer", message: "please verify.", preHandoffText: "Made the change." },
      },
      { agentName: "reviewer", response: "LGTM.", nextHandoff: null },
    ];
    const calls: ExecuteAgentArgs[] = [];
    const executor: AgentExecutor = {
      async execute(args: ExecuteAgentArgs): Promise<HandoffResult | null> {
        calls.push(args);
        snapshots.push({
          phaseAgents: args.chainContext?.completedPhases.map((e) => e.agent) ?? [],
          currentTask: args.chainContext?.currentTask,
        });
        if (queue.length === 0) {
          throw new Error("FakeAgentExecutor exhausted");
        }
        return queue.shift()!;
      },
    };
    const sink = new NullSink();
    const initial = "Plan looks good — handing off.\n\n[HANDOFF:builder] implement the change.";

    await executeChainCore({
      channelId: "test-chain-context",
      sink,
      executor,
      initialAgent: "orchestrator",
      initialResponse: initial,
      originAgent: "orchestrator",
    });

    // First executor call sees orchestrator → builder; chain context has 1 phase (orchestrator)
    assert.equal(calls[0].fromAgent, "orchestrator");
    assert.equal(calls[0].toAgent, "builder");
    assert.deepEqual(snapshots[0].phaseAgents, ["orchestrator"]);
    assert.equal(snapshots[0].currentTask, "implement the change.");

    // Second call sees builder → reviewer; chain context has 2 phases (orchestrator + builder)
    assert.equal(calls[1].fromAgent, "builder");
    assert.equal(calls[1].toAgent, "reviewer");
    assert.deepEqual(snapshots[1].phaseAgents, ["orchestrator", "builder"]);
    assert.equal(snapshots[1].currentTask, "please verify.");
  });

  it("auto-injects post-chain gates after a builder finishes (reviewer + tester)", async () => {
    // Initial: orchestrator → builder; builder produces a clean result with no further handoff.
    // Post-chain gates should fire reviewer then tester (POST_CHAIN_GATES["builder"]).
    const { executor, calls } = makeFakeExecutor([
      {
        agentName: "builder",
        response: "Wrote the patch. Tests pass locally.",
        nextHandoff: null,
      },
      { agentName: "reviewer", response: "Code reads cleanly.", nextHandoff: null },
      { agentName: "tester", response: "Verified — PASS.", nextHandoff: null },
    ]);
    const sink = new NullSink();

    const result = await executeChainCore({
      channelId: "test-chain-gates",
      sink,
      executor,
      initialAgent: "orchestrator",
      initialResponse: "Plan agreed.\n\n[HANDOFF:builder] implement it.",
      originAgent: "orchestrator",
    });

    // 3 executor calls: builder (chain), reviewer (gate), tester (gate)
    assert.equal(calls.length, 3);
    assert.equal(calls[0].toAgent, "builder");
    assert.equal(calls[1].toAgent, "reviewer");
    assert.equal(calls[2].toAgent, "tester");

    // 4 chain entries: orchestrator, builder, reviewer, tester
    assert.equal(result.entries.length, 4);
    assert.deepEqual(
      result.entries.map((e) => e.agent),
      ["orchestrator", "builder", "reviewer", "tester"],
    );

    // Gate fromAgent should be 'builder' (the canonical artifact source) for both gates
    assert.equal(calls[1].fromAgent, "builder");
    assert.equal(calls[2].fromAgent, "builder");
    // Gate prompts should include builder's output
    assert.ok(calls[1].handoffMessage.includes("Wrote the patch"));
    assert.ok(calls[2].handoffMessage.includes("Wrote the patch"));

    // Gate spawns must skip session resume — reviewer/tester are stateless
    // verifiers, accumulated session IDs cause "No conversation found"
    // errors on second-run gates (ERR-20260426-036). Chain steps stay with
    // default resume behavior.
    assert.equal(calls[0].skipSessionResume, undefined, "chain step (builder) should NOT skip session resume");
    assert.equal(calls[1].skipSessionResume, true, "reviewer gate must skip session resume");
    assert.equal(calls[2].skipSessionResume, true, "tester gate must skip session resume");
  });

  it("does not run post-chain gates when the final agent has no gate config", async () => {
    // Researcher → Reviewer chain; reviewer has no POST_CHAIN_GATES entry, so no auto-injection.
    const { executor, calls } = makeFakeExecutor([
      { agentName: "reviewer", response: "All good.", nextHandoff: null },
    ]);
    const sink = new NullSink();

    const result = await executeChainCore({
      channelId: "test-chain-no-gate",
      sink,
      executor,
      initialAgent: "researcher",
      initialResponse: "Done.\n\n[HANDOFF:reviewer] LGTM check.",
      originAgent: "researcher",
    });

    assert.equal(calls.length, 1);
    assert.equal(result.entries.length, 2);
  });
});

// ─── buildHandoffPrompt byte-equivalence guard ────────────────────────
//
// Net 2 of the Option B refactor verification (per
// vault/shared/regression-replay/refactor-snapshots/option-b-pre-refactor/README.md):
// the post-refactor `buildHandoffPrompt` helper must produce byte-identical
// output to the pre-refactor inline expression at handoff-router.ts:340 of
// the snapshot (sha 42dcee21450993a2e9762f438aaee728d02e0409). The inline
// expression is reproduced verbatim in `snapshotInlinePrompt` below.
//
// If this test ever drifts, the prompt-shape contract has been broken and
// downstream agents will receive different inputs than they did before
// the refactor.

function snapshotInlinePrompt(context: string, fromAgent: string, handoffMessage: string): string {
  // Verbatim from snapshot/handoff-router.ts:340 — the only change is that
  // `capitalize` is referenced via the same module so we get the same impl.
  const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
  return `${context}\n\n${cap(fromAgent)} has handed off to you with this request:\n${handoffMessage}`;
}

describe("Handoff Router — buildHandoffPrompt byte-equivalence (Option B Net 2)", () => {
  it("matches the pre-refactor inline prompt construction for a typical fixture", () => {
    const context = "[Project: lattice]\nDescription: Self-evolving generative art\nParticipating agents: orchestrator, builder, reviewer\nYou are the builder agent.\n\n--- Recent conversation ---\nuser: add a snapshot flag\n--- End of conversation ---";
    const fromAgent = "orchestrator";
    const handoffMessage = "Add a `--snapshot` flag to lattice that writes the current population to disk.";

    const expected = snapshotInlinePrompt(context, fromAgent, handoffMessage);
    const actual = buildHandoffPrompt(context, fromAgent, handoffMessage);

    assert.equal(actual, expected);
  });

  it("matches when handoffMessage spans multiple lines and contains markdown", () => {
    const context = "[Project: hey-lexxi]\nYou are the reviewer agent.";
    const fromAgent = "builder";
    const handoffMessage = "Review:\n\n- changed file: `src/extract.py`\n- lines added: 47\n\nFocus on the OCR fallback path.";

    const expected = snapshotInlinePrompt(context, fromAgent, handoffMessage);
    const actual = buildHandoffPrompt(context, fromAgent, handoffMessage);

    assert.equal(actual, expected);
  });

  it("matches when context is empty (degenerate but valid)", () => {
    const expected = snapshotInlinePrompt("", "researcher", "go");
    const actual = buildHandoffPrompt("", "researcher", "go");
    assert.equal(actual, expected);
  });

  it("preserves capitalize behavior exactly (lowercase agent names get capitalized; mixed-case stays as-is)", () => {
    const lower = buildHandoffPrompt("ctx", "builder", "msg");
    assert.ok(lower.includes("Builder has handed off to you"));

    const mixed = buildHandoffPrompt("ctx", "Codex-Builder", "msg");
    assert.ok(mixed.includes("Codex-Builder has handed off to you"));
  });
});

describe("Handoff Router — dequeueHandoff (tool-based handoff queue)", () => {
  it("returns null when no pending rows exist for the session", () => {
    const sessionKey = "test-dequeue-empty";
    cleanupHandoffQueue(sessionKey);
    assert.equal(dequeueHandoff(sessionKey), null);
  });

  it("returns the queued handoff and marks the row as consumed", () => {
    const sessionKey = "test-dequeue-single";
    cleanupHandoffQueue(sessionKey);
    const id = insertHandoffQueueRow({
      sessionKey,
      channelId: "test-channel-1",
      fromAgent: "orchestrator",
      targetAgent: "Builder", // intentionally mixed-case to verify lowercasing
      taskDescription: "implement the feature",
      preHandoffText: "I planned it out, builder takes it from here.",
    });

    const result = dequeueHandoff(sessionKey);
    assert.ok(result);
    assert.equal(result.targetAgent, "builder");
    assert.equal(result.message, "implement the feature");
    assert.equal(result.preHandoffText, "I planned it out, builder takes it from here.");

    // Row state transitioned pending → consumed
    const db = getDb();
    const row = db
      .prepare("SELECT status, consumed_at FROM handoff_queue WHERE id = ?")
      .get(id) as { status: string; consumed_at: string | null };
    assert.equal(row.status, "consumed");
    assert.ok(row.consumed_at);

    // Calling again returns null (idempotent — no longer pending)
    assert.equal(dequeueHandoff(sessionKey), null);

    cleanupHandoffQueue(sessionKey);
  });

  it("with multiple pending rows: returns FIRST, marks others as expired", () => {
    const sessionKey = "test-dequeue-multi";
    cleanupHandoffQueue(sessionKey);
    const id1 = insertHandoffQueueRow({
      sessionKey,
      channelId: "test-channel-2",
      fromAgent: "orchestrator",
      targetAgent: "researcher",
      taskDescription: "first",
    });
    const id2 = insertHandoffQueueRow({
      sessionKey,
      channelId: "test-channel-2",
      fromAgent: "orchestrator",
      targetAgent: "builder",
      taskDescription: "second",
    });
    const id3 = insertHandoffQueueRow({
      sessionKey,
      channelId: "test-channel-2",
      fromAgent: "orchestrator",
      targetAgent: "reviewer",
      taskDescription: "third",
    });

    const result = dequeueHandoff(sessionKey);
    assert.ok(result);
    assert.equal(result.targetAgent, "researcher");
    assert.equal(result.message, "first");

    const db = getDb();
    const rows = db
      .prepare("SELECT id, status FROM handoff_queue WHERE id IN (?, ?, ?) ORDER BY id ASC")
      .all(id1, id2, id3) as Array<{ id: number; status: string }>;
    assert.equal(rows.length, 3);
    assert.equal(rows[0].status, "consumed");
    assert.equal(rows[1].status, "expired");
    assert.equal(rows[2].status, "expired");

    cleanupHandoffQueue(sessionKey);
  });

  it("scopes by session_key (other sessions' rows are untouched)", () => {
    const sessionA = "test-dequeue-scope-a";
    const sessionB = "test-dequeue-scope-b";
    cleanupHandoffQueue(sessionA);
    cleanupHandoffQueue(sessionB);

    const idA = insertHandoffQueueRow({
      sessionKey: sessionA,
      channelId: "ch-a",
      fromAgent: "orchestrator",
      targetAgent: "builder",
      taskDescription: "for A",
    });
    const idB = insertHandoffQueueRow({
      sessionKey: sessionB,
      channelId: "ch-b",
      fromAgent: "orchestrator",
      targetAgent: "reviewer",
      taskDescription: "for B",
    });

    const resultA = dequeueHandoff(sessionA);
    assert.ok(resultA);
    assert.equal(resultA.targetAgent, "builder");

    // B is still pending
    const db = getDb();
    const rowB = db.prepare("SELECT status FROM handoff_queue WHERE id = ?").get(idB) as { status: string };
    assert.equal(rowB.status, "pending");

    cleanupHandoffQueue(sessionA);
    cleanupHandoffQueue(sessionB);
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
