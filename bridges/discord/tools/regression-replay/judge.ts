// LLM-as-judge module. Calls a judge model with a pair of (baseline,
// candidate) outputs and the rubric. Returns the parsed verdict.
//
// Bypasses buildClaudeConfig/buildCodexConfig — the judge does NOT need
// vault context injection (would contaminate evaluation). Constructs a
// minimal CLI invocation directly so the judge sees only what we send.

import { spawn } from "child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  unlinkSync,
  writeFileSync,
} from "fs";
import { join } from "path";

const HARNESS_ROOT = process.env.HARNESS_ROOT ?? process.cwd();
const TEMP_DIR = join(HARNESS_ROOT, "bridges", "discord", ".tmp");
const RUBRIC_PATH = join(
  HARNESS_ROOT,
  "vault",
  "shared",
  "regression-replay",
  "rubric.md",
);
const CALIBRATION_DIR = join(
  HARNESS_ROOT,
  "vault",
  "shared",
  "regression-replay",
  "calibration",
);

export type JudgeName = "sonnet" | "codex";

export type Verdict = "pass" | "regress" | "unclear";

export interface JudgeVerdict {
  judge: JudgeName;
  verdict: Verdict;
  reason: string;
  evidence: string;
  raw: string;
  ok: boolean;
  error?: string;
  durationMs: number;
  // Cost in USD if the runner surfaced it (sonnet via claude-runner;
  // codex-runner does not currently emit cost). Undefined when not available.
  costUsd?: number;
}

export interface JudgeOptions {
  judge: JudgeName;
  agentRole: string;
  shape: string;
  baselineOutput: string;
  candidateOutput: string;
  prompt: string;
  timeoutMs?: number;
}

const JUDGE_INSTRUCTIONS = `You are an evaluation judge for an agent-replay regression suite. You will be given:

1. The rubric describing pass/regress/unclear semantics for each agent role.
2. Calibration anchors (if any) — past examples where the principal expert flagged outputs as regress or unclear.
3. The original task prompt that both agents were given.
4. The BASELINE output (captured at pin time, treated as the reference).
5. The CANDIDATE output (the current run, what we're evaluating).

Your job: compare the candidate to the baseline using the rubric. You are NOT judging absolute quality — only whether the candidate is at parity, regressed, or different-but-uncertain relative to the baseline.

Output requirements:
- Use the verdict tier "unclear" liberally. False-pass is more dangerous than false-flag.
- Output STRICTLY a single JSON object with no surrounding prose, no code fences, no explanation outside the object.
- Required fields: verdict ("pass" | "regress" | "unclear"), reason (one sentence), evidence (specific quote or pointer to the divergence, max 200 chars).

Format:
{"verdict": "...", "reason": "...", "evidence": "..."}`;

function loadCalibrationAnchors(agentRole: string, shape: string): string {
  if (!existsSync(CALIBRATION_DIR)) return "";
  const files = readdirSync(CALIBRATION_DIR).filter(
    (f) => f.startsWith("pair-") && f.endsWith(".json"),
  );
  if (files.length === 0) return "";

  const pairs: Array<{
    score: number;
    text: string;
  }> = [];

  for (const f of files) {
    try {
      const raw = readFileSync(join(CALIBRATION_DIR, f), "utf-8");
      const pair = JSON.parse(raw);
      let score = 0;
      if (pair.agent_role === agentRole) score += 2;
      if (pair.shape === shape) score += 3;
      pairs.push({
        score,
        text: `--- Calibration anchor ${pair.id} ---\nAgent role: ${pair.agent_role}\nShape: ${pair.shape}\nContext: ${pair.context?.slice(0, 300) ?? ""}\nCandidate output: ${pair.candidate_output?.slice(0, 600) ?? ""}\nExpert critique: ${pair.your_critique}\nVerdict: ${pair.verdict}\nRationale: ${pair.rationale}`,
      });
    } catch {
      // Skip malformed pairs.
    }
  }

  pairs.sort((a, b) => b.score - a.score);
  const top = pairs.slice(0, 5);
  if (top.length === 0) return "";
  return (
    "\n\nCalibration anchors (use these to align your verdict with prior expert judgments):\n\n" +
    top.map((p) => p.text).join("\n\n")
  );
}

function loadRubric(): string {
  try {
    return readFileSync(RUBRIC_PATH, "utf-8");
  } catch {
    return "(rubric file not found)";
  }
}

function buildJudgePrompt(opts: JudgeOptions): string {
  const rubric = loadRubric();
  const anchors = loadCalibrationAnchors(opts.agentRole, opts.shape);
  return `${JUDGE_INSTRUCTIONS}

--- RUBRIC (v2) ---

${rubric}
${anchors}

--- TASK PROMPT (what both runs were asked) ---

${opts.prompt}

--- BASELINE OUTPUT (reference, captured at pin time) ---

${opts.baselineOutput}

--- CANDIDATE OUTPUT (current run, what you are evaluating) ---

${opts.candidateOutput}

--- AGENT ROLE BEING JUDGED: ${opts.agentRole} ---

Output the verdict JSON now (no prose around it):`;
}

function parseVerdict(raw: string): {
  verdict: Verdict;
  reason: string;
  evidence: string;
} | null {
  // Find the first {...} block in the response.
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  const block = raw.slice(start, end + 1);
  try {
    const parsed = JSON.parse(block);
    const verdict = String(parsed.verdict || "").toLowerCase();
    if (verdict !== "pass" && verdict !== "regress" && verdict !== "unclear") {
      return null;
    }
    return {
      verdict: verdict as Verdict,
      reason: String(parsed.reason || ""),
      evidence: String(parsed.evidence || ""),
    };
  } catch {
    return null;
  }
}

function uniqueRequestId(): string {
  return `judge-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

interface JudgeProcessResult {
  ok: boolean;
  raw: string;
  error?: string;
  costUsd?: number;
}

function extractJudgeCostFromInner(inner: string): number | undefined {
  try {
    const parsed = JSON.parse(inner);
    if (typeof parsed?.total_cost_usd === "number") return parsed.total_cost_usd;
  } catch {}
  const m = inner.match(/"total_cost_usd"\s*:\s*([0-9.eE+\-]+)/);
  return m ? parseFloat(m[1]) : undefined;
}

async function spawnJudgeProcess(
  judge: JudgeName,
  prompt: string,
  outputFile: string,
  timeoutMs: number,
): Promise<JudgeProcessResult> {
  return new Promise((resolve) => {
    const harnessRoot = HARNESS_ROOT;
    let cmd: string;
    let args: string[];
    if (judge === "sonnet") {
      cmd = "python3";
      args = [
        join(harnessRoot, "bridges", "discord", "claude-runner.py"),
        outputFile,
        "-p",
        "--output-format",
        "json",
        "--dangerously-skip-permissions",
        "--model",
        "sonnet",
        "--",
        prompt,
      ];
    } else {
      // Codex judge — uses codex CLI directly via codex-runner.py.
      // codex-runner.py prepends `codex exec` itself, so codex_args here are
      // codex-exec flags only. Mirror the same flag set buildCodexConfig
      // uses (--json, -s read-only, --skip-git-repo-check, approval=never)
      // so the judge invocation stays consistent with how the bot spawns
      // codex normally — minus the workspace-write sandbox.
      const promptFile = join(TEMP_DIR, `judge-prompt-${uniqueRequestId()}.txt`);
      writeFileSync(promptFile, prompt, "utf-8");
      cmd = "python3";
      args = [
        join(harnessRoot, "bridges", "discord", "codex-runner.py"),
        outputFile,
        "--prompt-file",
        promptFile,
        "--json",
        "-s",
        "read-only",
        "-C",
        harnessRoot,
        "--skip-git-repo-check",
        "-c",
        'approval_policy="never"',
      ];
    }

    const proc = spawn(cmd, args, {
      cwd: harnessRoot,
      env: { ...process.env, HARNESS_ROOT: harnessRoot },
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stderr = "";
    proc.stderr?.on("data", (d) => {
      stderr += d.toString();
    });
    proc.stdout?.on("data", () => {});

    const timer = setTimeout(() => {
      try {
        proc.kill("SIGTERM");
      } catch {}
      resolve({
        ok: false,
        raw: "",
        error: `judge timed out after ${timeoutMs}ms`,
      });
    }, timeoutMs);

    proc.on("exit", (code) => {
      clearTimeout(timer);
      if (code === 0 && existsSync(outputFile)) {
        try {
          const fileRaw = readFileSync(outputFile, "utf-8");
          try {
            const envelope = JSON.parse(fileRaw);
            const innerStdout =
              typeof envelope?.stdout === "string" ? envelope.stdout : "";
            const costUsd = innerStdout
              ? extractJudgeCostFromInner(innerStdout)
              : undefined;
            if (judge === "codex") {
              if (typeof envelope?.lastMessage === "string") {
                resolve({ ok: true, raw: envelope.lastMessage, costUsd });
                return;
              }
              if (innerStdout) {
                resolve({ ok: true, raw: innerStdout, costUsd });
                return;
              }
            }
            if (innerStdout) {
              resolve({ ok: true, raw: innerStdout, costUsd });
              return;
            }
          } catch {
            // not wrapped — pass through.
          }
          resolve({ ok: true, raw: fileRaw });
        } catch (e) {
          resolve({
            ok: false,
            raw: "",
            error: `failed to read output: ${(e as Error).message}`,
          });
        }
      } else {
        resolve({
          ok: false,
          raw: "",
          error: `judge exit ${code}; stderr: ${stderr.slice(-300)}`,
        });
      }
    });

    proc.on("error", (err) => {
      clearTimeout(timer);
      resolve({
        ok: false,
        raw: "",
        error: `spawn error: ${err.message}`,
      });
    });
  });
}

function extractTextFromJudgeRaw(judge: JudgeName, raw: string): string {
  // For codex, raw is already the lastMessage string (extracted in
  // spawnJudgeProcess). For sonnet, raw is the inner stdout JSON which has
  // .result containing the response text.
  if (judge === "codex") return raw;

  try {
    const parsed = JSON.parse(raw);
    if (typeof parsed?.result === "string") return parsed.result;
    if (typeof parsed?.text === "string") return parsed.text;
  } catch {}
  const m = raw.match(/"result"\s*:\s*"((?:[^"\\]|\\.)*)"/);
  if (m) return m[1].replace(/\\n/g, "\n").replace(/\\"/g, '"');
  return raw;
}

export async function runJudge(opts: JudgeOptions): Promise<JudgeVerdict> {
  const startedAt = Date.now();
  if (!existsSync(TEMP_DIR)) mkdirSync(TEMP_DIR, { recursive: true });
  const outputFile = join(
    TEMP_DIR,
    `judge-${opts.judge}-${uniqueRequestId()}.json`,
  );
  const prompt = buildJudgePrompt(opts);
  const timeoutMs = opts.timeoutMs ?? 3 * 60 * 1000;

  try {
    const result = await spawnJudgeProcess(
      opts.judge,
      prompt,
      outputFile,
      timeoutMs,
    );
    if (!result.ok) {
      return {
        judge: opts.judge,
        verdict: "unclear",
        reason: "judge process failed",
        evidence: result.error ?? "",
        raw: result.raw,
        ok: false,
        error: result.error,
        durationMs: Date.now() - startedAt,
        costUsd: result.costUsd,
      };
    }

    const text = extractTextFromJudgeRaw(opts.judge, result.raw);
    const parsed = parseVerdict(text);
    if (!parsed) {
      return {
        judge: opts.judge,
        verdict: "unclear",
        reason: "could not parse verdict JSON from judge response",
        evidence: text.slice(0, 200),
        raw: text,
        ok: false,
        error: "verdict-parse-failure",
        durationMs: Date.now() - startedAt,
        costUsd: result.costUsd,
      };
    }

    return {
      judge: opts.judge,
      verdict: parsed.verdict,
      reason: parsed.reason,
      evidence: parsed.evidence,
      raw: text,
      ok: true,
      durationMs: Date.now() - startedAt,
      costUsd: result.costUsd,
    };
  } finally {
    try {
      unlinkSync(outputFile);
    } catch {}
  }
}
