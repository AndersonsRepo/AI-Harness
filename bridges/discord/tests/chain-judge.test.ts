// Unit tests for chain-judge. Mocks runJudge via dependency injection so
// nothing spawns a real model — all assertions are deterministic.
//
// Three judging modes covered:
//   gate_bypass — deterministic safety check, no judge calls
//   per_step    — routes align, PoLL per step
//   outcome     — routes diverge, single concatenated judge call

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  judgeChainRun,
  chainVerdictToPollResult,
  type RunJudgeFn,
} from "../tools/regression-replay/chain-judge.js";
import type { JudgeOptions, JudgeVerdict, Verdict } from "../tools/regression-replay/judge.js";
import type { ChainBaselineEntry } from "../tools/regression-replay/seed-loader.js";

function entry(agent: string, response: string, opts?: { is_gate?: boolean; step?: number }): ChainBaselineEntry {
  return {
    agent,
    response,
    duration_ms: 100,
    step: opts?.step ?? 0,
    is_gate: opts?.is_gate ?? false,
  };
}

/**
 * Build a mock runJudge keyed by agentRole. Returns the planned verdict
 * for each (judge, agentRole) call. Tracks call count + agentRole so
 * tests can assert which judging path fired.
 */
function mockJudge(plan: Record<string, Verdict | { sonnet: Verdict; codex: Verdict }>): {
  fn: RunJudgeFn;
  calls: { judge: string; agentRole: string }[];
} {
  const calls: { judge: string; agentRole: string }[] = [];
  const fn: RunJudgeFn = async (opts: JudgeOptions): Promise<JudgeVerdict> => {
    calls.push({ judge: opts.judge, agentRole: opts.agentRole });
    const planned = plan[opts.agentRole];
    if (!planned) {
      throw new Error(`mockJudge: no plan for agentRole=${opts.agentRole}`);
    }
    const verdict: Verdict =
      typeof planned === "string"
        ? planned
        : opts.judge === "sonnet"
          ? planned.sonnet
          : planned.codex;
    return {
      judge: opts.judge,
      verdict,
      reason: `mock ${opts.judge} ${verdict}`,
      evidence: `mock evidence ${verdict}`,
      raw: "{}",
      ok: true,
      durationMs: 1,
      costUsd: 0.001,
    };
  };
  return { fn, calls };
}

// ─── Gate bypass mode ──────────────────────────────────────────────────

test("gate_bypass: missing reviewer gate from baseline → regress with no judge calls", async () => {
  const baseline = [
    entry("orchestrator", "x", { step: 0 }),
    entry("builder", "y", { step: 1 }),
    entry("reviewer", "review pass", { step: 2, is_gate: true }),
    entry("tester", "tests pass", { step: 3, is_gate: true }),
  ];
  const candidate = [
    entry("orchestrator", "x", { step: 0 }),
    entry("builder", "y", { step: 1 }),
    // reviewer + tester both bypassed
  ];
  const judge = mockJudge({});
  const verdict = await judgeChainRun({
    baseline,
    candidate,
    prompt: "p",
    shape: "test",
    runJudge: judge.fn,
  });
  assert.equal(verdict.final, "regress");
  assert.equal(verdict.judging_mode, "gate_bypass");
  assert.equal(verdict.steps.length, 0);
  assert.equal(judge.calls.length, 0); // no judge spend on deterministic safety violation
  assert.equal(verdict.judge_cost_usd, 0);
  assert.match(verdict.evidence_summary, /safety gate\(s\) bypassed/);
  assert.match(verdict.evidence_summary, /reviewer/);
});

test("gate_bypass: missing tester only → regress (any missing gate triggers)", async () => {
  const baseline = [
    entry("orchestrator", "x", { step: 0 }),
    entry("builder", "y", { step: 1 }),
    entry("reviewer", "ok", { step: 2, is_gate: true }),
    entry("tester", "ok", { step: 3, is_gate: true }),
  ];
  const candidate = [
    entry("orchestrator", "x", { step: 0 }),
    entry("builder", "y", { step: 1 }),
    entry("reviewer", "ok", { step: 2, is_gate: true }),
    // tester missing
  ];
  const judge = mockJudge({});
  const verdict = await judgeChainRun({
    baseline,
    candidate,
    prompt: "p",
    shape: "test",
    runJudge: judge.fn,
  });
  assert.equal(verdict.final, "regress");
  assert.equal(verdict.judging_mode, "gate_bypass");
  assert.equal(judge.calls.length, 0);
  assert.match(verdict.evidence_summary, /tester/);
});

test("gate_bypass: baseline has no gates → falls through to other modes", async () => {
  // Baseline doesn't have any is_gate=true entries, so there's no gate to
  // bypass. Routes align here, so we expect per_step mode to fire.
  const baseline = [entry("orchestrator", "x", { step: 0 }), entry("researcher", "y", { step: 1 })];
  const candidate = [entry("orchestrator", "x", { step: 0 }), entry("researcher", "y", { step: 1 })];
  const judge = mockJudge({ orchestrator: "pass", researcher: "pass" });
  const verdict = await judgeChainRun({
    baseline,
    candidate,
    prompt: "p",
    shape: "test",
    runJudge: judge.fn,
  });
  assert.equal(verdict.judging_mode, "per_step");
  assert.equal(verdict.final, "pass");
});

// ─── Per-step mode (routes align) ──────────────────────────────────────

test("per_step: returns pass when every step passes both judges", async () => {
  const baseline = [
    entry("orchestrator", "x", { step: 0 }),
    entry("builder", "y", { step: 1 }),
    entry("reviewer", "z", { step: 2, is_gate: true }),
  ];
  const candidate = [...baseline];
  const judge = mockJudge({
    orchestrator: "pass",
    builder: "pass",
    reviewer: "pass",
  });
  const verdict = await judgeChainRun({
    baseline,
    candidate,
    prompt: "p",
    shape: "test",
    runJudge: judge.fn,
  });
  assert.equal(verdict.final, "pass");
  assert.equal(verdict.judging_mode, "per_step");
  assert.equal(verdict.steps.length, 3);
  assert.equal(judge.calls.length, 6); // 3 steps × 2 judges
  assert.equal(verdict.weakest_step, undefined);
});

test("per_step: returns regress when any mid-chain step regresses, weakest_step points to it", async () => {
  const baseline = [
    entry("orchestrator", "x", { step: 0 }),
    entry("builder", "y", { step: 1 }),
    entry("reviewer", "z", { step: 2, is_gate: true }),
  ];
  const candidate = [...baseline];
  const judge = mockJudge({
    orchestrator: "pass",
    builder: "regress",
    reviewer: "pass",
  });
  const verdict = await judgeChainRun({
    baseline,
    candidate,
    prompt: "p",
    shape: "test",
    runJudge: judge.fn,
  });
  assert.equal(verdict.final, "regress");
  assert.equal(verdict.judging_mode, "per_step");
  assert.equal(verdict.weakest_step?.step, 1);
  assert.equal(verdict.weakest_step?.agent, "builder");
  assert.equal(judge.calls.length, 6);
});

test("per_step: gate-step regress is NOT softened — propagates as run regress", async () => {
  const baseline = [
    entry("orchestrator", "x", { step: 0 }),
    entry("builder", "y", { step: 1 }),
    entry("reviewer", "z", { step: 2, is_gate: true }),
  ];
  const candidate = [...baseline];
  const judge = mockJudge({
    orchestrator: "pass",
    builder: "pass",
    reviewer: "regress",
  });
  const verdict = await judgeChainRun({
    baseline,
    candidate,
    prompt: "p",
    shape: "test",
    runJudge: judge.fn,
  });
  assert.equal(verdict.final, "regress");
  assert.equal(verdict.judging_mode, "per_step");
  assert.equal(verdict.weakest_step?.step, 2);
  const reviewerStep = verdict.steps.find((s) => s.agent === "reviewer");
  assert.equal(reviewerStep?.is_gate, true);
});

test("per_step: returns disagreement when sonnet and codex split on a step", async () => {
  const baseline = [entry("orchestrator", "x", { step: 0 }), entry("builder", "y", { step: 1 })];
  const candidate = [...baseline];
  const judge = mockJudge({
    orchestrator: "pass",
    builder: { sonnet: "pass", codex: "regress" },
  });
  const verdict = await judgeChainRun({
    baseline,
    candidate,
    prompt: "p",
    shape: "test",
    runJudge: judge.fn,
  });
  assert.equal(verdict.final, "disagreement");
  assert.equal(verdict.judging_mode, "per_step");
});

test("per_step: aggregates judge_cost_usd across all step calls", async () => {
  const baseline = [
    entry("orchestrator", "x", { step: 0 }),
    entry("builder", "y", { step: 1 }),
    entry("reviewer", "z", { step: 2, is_gate: true }),
  ];
  const candidate = [...baseline];
  const judge = mockJudge({
    orchestrator: "pass",
    builder: "pass",
    reviewer: "pass",
  });
  const verdict = await judgeChainRun({
    baseline,
    candidate,
    prompt: "p",
    shape: "test",
    runJudge: judge.fn,
  });
  // mockJudge returns 0.001 per call. 3 steps × 2 judges = 6 calls.
  assert.equal(verdict.judge_cost_usd, 0.006);
});

// ─── Outcome mode (routes diverge but no gate bypassed) ────────────────

test("outcome: chain depth differs (no gates involved) → outcome judging fires", async () => {
  // This is the shape-04 smoke scenario: baseline orch only, candidate
  // orch + tester. No gates present in either, so it's not a gate bypass.
  // Should fall into outcome-mode judging.
  const baseline = [entry("orchestrator", "plan A", { step: 0 })];
  const candidate = [
    entry("orchestrator", "plan A", { step: 0 }),
    entry("tester", "tests added", { step: 1 }),
  ];
  const judge = mockJudge({ chain: "pass" });
  const verdict = await judgeChainRun({
    baseline,
    candidate,
    prompt: "p",
    shape: "test",
    runJudge: judge.fn,
  });
  assert.equal(verdict.judging_mode, "outcome");
  assert.equal(verdict.final, "pass");
  // Outcome-mode uses agentRole="chain" — single PoLL call (sonnet+codex)
  assert.equal(judge.calls.length, 2);
  assert.equal(judge.calls[0].agentRole, "chain");
  assert.equal(judge.calls[1].agentRole, "chain");
  assert.match(verdict.evidence_summary, /outcome-mode/);
  assert.match(verdict.evidence_summary, /baseline orchestrator/);
  assert.match(verdict.evidence_summary, /candidate orchestrator → tester/);
});

test("outcome: agent name diverges mid-chain (no gate involved) → outcome judging", async () => {
  // Different specialist chosen for the same role — researcher vs education.
  // Neither is a gate, so we trust the judge to assess output quality.
  const baseline = [
    entry("orchestrator", "plan", { step: 0 }),
    entry("researcher", "investigation", { step: 1 }),
  ];
  const candidate = [
    entry("orchestrator", "plan", { step: 0 }),
    entry("education", "investigation", { step: 1 }),
  ];
  const judge = mockJudge({ chain: "unclear" });
  const verdict = await judgeChainRun({
    baseline,
    candidate,
    prompt: "p",
    shape: "test",
    runJudge: judge.fn,
  });
  assert.equal(verdict.judging_mode, "outcome");
  assert.equal(verdict.final, "unclear");
});

test("outcome: judge can return regress on routing-divergent chains too", async () => {
  // Outcome-mode is not a free pass — the judge can still decide the
  // candidate's output is materially worse than the baseline's.
  const baseline = [entry("orchestrator", "thorough plan", { step: 0 }), entry("researcher", "depth", { step: 1 })];
  const candidate = [entry("orchestrator", "shallow plan", { step: 0 })];
  const judge = mockJudge({ chain: "regress" });
  const verdict = await judgeChainRun({
    baseline,
    candidate,
    prompt: "p",
    shape: "test",
    runJudge: judge.fn,
  });
  assert.equal(verdict.judging_mode, "outcome");
  assert.equal(verdict.final, "regress");
  assert.equal(verdict.weakest_step?.agent, "chain");
});

// ─── PollResult flattening for Pass^k ──────────────────────────────────

test("chainVerdictToPollResult flattens a ChainRunVerdict into the PollResult shape Pass^k consumes", () => {
  const result = chainVerdictToPollResult({
    steps: [],
    final: "regress",
    judging_mode: "gate_bypass",
    weakest_step: { step: -1, agent: "reviewer", reason: "gate did not fire" },
    evidence_summary: "safety gate bypassed",
    judge_cost_usd: 0,
  });
  assert.deepEqual(result.judges, []);
  assert.equal(result.final, "regress");
  assert.equal(result.disagreement, false);
  assert.equal(result.evidence_summary, "safety gate bypassed");
});

test("chainVerdictToPollResult sets disagreement=true only for the disagreement verdict", () => {
  const r = chainVerdictToPollResult({
    steps: [],
    final: "disagreement",
    judging_mode: "per_step",
    evidence_summary: "judges split",
    judge_cost_usd: 0,
  });
  assert.equal(r.disagreement, true);
});
