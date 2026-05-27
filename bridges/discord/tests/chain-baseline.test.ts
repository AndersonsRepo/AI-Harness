// Unit tests for chain-aware pin-capture + replay helpers. Validates the
// step-by-step mapping logic in buildChainResponses and the replay
// driver's run-aggregation, all without spending money on real agent
// spawns.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  buildChainResponses,
  buildCaptureContext,
  POST_CHAIN_GATE_AGENTS,
  persistChainCandidate,
  type ChainCapture,
} from "../tools/regression-replay/chain-baseline.js";
import type { ChainEntry } from "../handoff-router.js";
import type { ChainBaselineEntry } from "../tools/regression-replay/seed-loader.js";

function makeChainEntry(agent: string, responseText: string): ChainEntry {
  // Production truncates to 2000 in the chain log — mirror that here so the
  // test verifies our full-text recovery path actually replaces it.
  return {
    agent,
    response: responseText.slice(0, 2000),
    timestamp: Date.now(),
  };
}

test("buildChainResponses preserves full text for initial agent", () => {
  const fullOrchestratorResponse = "x".repeat(8000);
  const capture: ChainCapture = {
    initialAgent: "orchestrator",
    initialResponse: fullOrchestratorResponse,
    initialDurationMs: 12345,
    chainEntries: [makeChainEntry("orchestrator", fullOrchestratorResponse)],
    recordedSteps: [],
    recordedStepCostsUsd: [],
    initialAgentCostUsd: 0,
  };
  const result = buildChainResponses(capture, POST_CHAIN_GATE_AGENTS);
  assert.equal(result.length, 1);
  assert.equal(result[0].response.length, 8000);
  assert.equal(result[0].duration_ms, 12345);
  assert.equal(result[0].step, 0);
  assert.equal(result[0].is_gate, false);
});

test("buildChainResponses recovers full text from TimingExecutor.steps for handoff steps", () => {
  const fullOrchestrator = "orch ".repeat(2000); // 10000 chars, > 2000 truncation
  const fullBuilder = "build ".repeat(1000); // 6000 chars
  const fullReviewer = "review ".repeat(800); // 5600 chars
  const fullTester = "test ".repeat(900); // 4500 chars

  const capture: ChainCapture = {
    initialAgent: "orchestrator",
    initialResponse: fullOrchestrator,
    initialDurationMs: 100,
    chainEntries: [
      makeChainEntry("orchestrator", fullOrchestrator),
      makeChainEntry("builder", fullBuilder),
      makeChainEntry("reviewer", fullReviewer),
      makeChainEntry("tester", fullTester),
    ],
    recordedSteps: [
      { agent: "builder", fullResponse: fullBuilder, duration_ms: 200 },
      { agent: "reviewer", fullResponse: fullReviewer, duration_ms: 300 },
      { agent: "tester", fullResponse: fullTester, duration_ms: 400 },
    ],
    recordedStepCostsUsd: [0, 0, 0],
    initialAgentCostUsd: 0,
  };
  const result = buildChainResponses(capture, POST_CHAIN_GATE_AGENTS);

  assert.equal(result.length, 4);

  // Initial agent: full text from initialResponse, not the truncated chainEntry
  assert.equal(result[0].response.length, fullOrchestrator.length);
  assert.equal(result[0].duration_ms, 100);
  assert.equal(result[0].is_gate, false);

  // Builder: full text from recordedSteps, not the 2000-char truncation
  assert.equal(result[1].response.length, fullBuilder.length);
  assert.equal(result[1].duration_ms, 200);
  assert.equal(result[1].is_gate, false); // builder is not a gate
  assert.equal(result[1].step, 1);

  // Reviewer: gate marker set, full text preserved
  assert.equal(result[2].response.length, fullReviewer.length);
  assert.equal(result[2].duration_ms, 300);
  assert.equal(result[2].is_gate, true);
  assert.equal(result[2].step, 2);

  // Tester: gate marker set, full text preserved
  assert.equal(result[3].response.length, fullTester.length);
  assert.equal(result[3].duration_ms, 400);
  assert.equal(result[3].is_gate, true);
  assert.equal(result[3].step, 3);
});

test("buildChainResponses handles chains where the same agent appears twice via ordinal mapping", () => {
  // Orchestrator → Researcher → Researcher (researcher gets re-invoked, e.g.
  // after a follow-up handoff). The ordinal mapping must NOT collide on
  // agent name; each researcher invocation gets its own RecordedStep.
  const capture: ChainCapture = {
    initialAgent: "orchestrator",
    initialResponse: "orch full",
    initialDurationMs: 100,
    chainEntries: [
      makeChainEntry("orchestrator", "orch full"),
      makeChainEntry("researcher", "first researcher run"),
      makeChainEntry("researcher", "second researcher run"),
    ],
    recordedSteps: [
      { agent: "researcher", fullResponse: "first researcher run full", duration_ms: 200 },
      { agent: "researcher", fullResponse: "second researcher run full", duration_ms: 300 },
    ],
    recordedStepCostsUsd: [0, 0],
    initialAgentCostUsd: 0,
  };
  const result = buildChainResponses(capture, POST_CHAIN_GATE_AGENTS);
  assert.equal(result.length, 3);
  assert.equal(result[1].response, "first researcher run full");
  assert.equal(result[1].duration_ms, 200);
  assert.equal(result[2].response, "second researcher run full");
  assert.equal(result[2].duration_ms, 300);
});

test("buildChainResponses falls back to chain entry text when recordedSteps is short", () => {
  // Defensive: if the chain primitive somehow recorded an entry without a
  // matching executor invocation (shouldn't happen in practice), fall back
  // to the (truncated) chainEntry text rather than crashing.
  const capture: ChainCapture = {
    initialAgent: "orchestrator",
    initialResponse: "orch full",
    initialDurationMs: 100,
    chainEntries: [
      makeChainEntry("orchestrator", "orch full"),
      makeChainEntry("builder", "builder truncated text"),
    ],
    recordedSteps: [], // empty — simulate the defensive case
    recordedStepCostsUsd: [],
    initialAgentCostUsd: 0,
  };
  const result = buildChainResponses(capture, POST_CHAIN_GATE_AGENTS);
  assert.equal(result.length, 2);
  assert.equal(result[1].response, "builder truncated text");
  assert.equal(result[1].duration_ms, 0);
});

test("buildCaptureContext includes completed phases when chain context is supplied", () => {
  const seed = {
    id: "shape-test",
    shape: "test-shape",
    expected_agents: ["orchestrator", "builder", "reviewer"],
  };
  const ctx = buildCaptureContext(seed, "builder", {
    completedPhases: [
      { agent: "orchestrator", response: "orchestrator output", timestamp: 1 },
    ],
    currentTask: "implement the thing",
  });
  assert.match(ctx, /You are the builder agent\./);
  assert.match(ctx, /--- Completed phases ---/);
  assert.match(ctx, /\[orchestrator\]: orchestrator output/);
  assert.match(ctx, /Available agents: orchestrator, builder, reviewer/);
});

test("buildCaptureContext omits completed-phases section on the first step", () => {
  const seed = {
    id: "shape-test",
    shape: "test-shape",
    expected_agents: ["orchestrator", "builder"],
  };
  const ctx = buildCaptureContext(seed, "orchestrator", {
    completedPhases: [],
    currentTask: "kick off",
  });
  assert.doesNotMatch(ctx, /--- Completed phases ---/);
  assert.match(ctx, /You are the orchestrator agent\./);
});

test("POST_CHAIN_GATE_AGENTS matches the production POST_CHAIN_GATES mapping", () => {
  // Hard-coded dual-source-of-truth check. If POST_CHAIN_GATES in
  // handoff-router.ts changes, this test fails loudly so the gate-marker
  // logic in buildChainResponses doesn't silently drift.
  assert.deepEqual([...POST_CHAIN_GATE_AGENTS].sort(), ["reviewer", "tester"]);
});

// ─── Replay driver: candidate persistence ──────────────────────────────

test("persistChainCandidate writes JSON to a deterministic path and returns the relative form", () => {
  const tmp = mkdtempSync(join(tmpdir(), "chain-replay-test-"));
  try {
    const responses: ChainBaselineEntry[] = [
      { agent: "orchestrator", response: "plan", duration_ms: 100, step: 0, is_gate: false },
      { agent: "builder", response: "diff", duration_ms: 200, step: 1, is_gate: false },
      { agent: "reviewer", response: "ships", duration_ms: 50, step: 2, is_gate: true },
    ];
    const relPath = persistChainCandidate(
      tmp,
      "runs/candidates",
      "shape-test",
      0,
      "2026-04-29",
      responses,
    );

    // Path is relative-form for the scorecard
    assert.equal(relPath, "runs/candidates/2026-04-29-shape-test-run-1-chain.json");

    // File exists and round-trips losslessly
    const files = readdirSync(tmp);
    assert.equal(files.length, 1);
    assert.equal(files[0], "2026-04-29-shape-test-run-1-chain.json");
    const parsed = JSON.parse(readFileSync(join(tmp, files[0]), "utf-8"));
    assert.deepEqual(parsed, responses);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("persistChainCandidate uses 1-based run numbers in filenames", () => {
  // 0-based runIdx maps to 1-based human-friendly file numbering.
  const tmp = mkdtempSync(join(tmpdir(), "chain-replay-test-"));
  try {
    const responses: ChainBaselineEntry[] = [
      { agent: "orchestrator", response: "x", duration_ms: 1, step: 0, is_gate: false },
    ];
    const r0 = persistChainCandidate(tmp, "runs/candidates", "shape-z", 0, "2026-04-29", responses);
    const r1 = persistChainCandidate(tmp, "runs/candidates", "shape-z", 1, "2026-04-29", responses);
    const r2 = persistChainCandidate(tmp, "runs/candidates", "shape-z", 2, "2026-04-29", responses);
    assert.match(r0, /run-1-chain\.json$/);
    assert.match(r1, /run-2-chain\.json$/);
    assert.match(r2, /run-3-chain\.json$/);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});
