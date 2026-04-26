// Programmatic agent spawn helper for tier-2 replay and judging.
//
// Wraps claude-runner.py / codex-runner.py via subprocess so we can run a
// single agent invocation end-to-end and capture the response text. Reuses
// the same buildClaudeConfig / buildCodexConfig that the bot uses, so the
// spawn behaves like a real Discord task spawn would.

import { spawn } from "child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
  renameSync,
} from "fs";
import { join } from "path";
import { buildClaudeConfig, extractResponse } from "../../claude-config.js";
import {
  buildCodexConfig,
  extractCodexResponse,
} from "../../codex-config.js";

const HARNESS_ROOT = process.env.HARNESS_ROOT ?? process.cwd();
const TEMP_DIR = join(HARNESS_ROOT, "bridges", "discord", ".tmp");

export type Runtime = "claude" | "codex";

export interface SpawnAgentOptions {
  runtime: Runtime;
  agentName: string;
  prompt: string;
  channelId: string;
  // Hard upper bound — the runner has its own retry loop; this is the
  // outer wall-clock cap. Default 5 min for replay.
  timeoutMs?: number;
}

export interface SpawnAgentResult {
  ok: boolean;
  responseText: string | null;
  durationMs: number;
  rawOutputPath?: string;
  error?: string;
  // Cost in USD if the runner reported it. claude-runner output has
  // `total_cost_usd` in the inner result; codex-runner does not currently
  // surface cost directly so this stays undefined for codex.
  costUsd?: number;
}

function extractClaudeCostFromInner(inner: string): number | undefined {
  // The inner stdout is typically a single JSON line for `--output-format json`.
  // Look for total_cost_usd in the parsed structure first, then regex fallback.
  try {
    const parsed = JSON.parse(inner);
    if (typeof parsed?.total_cost_usd === "number") return parsed.total_cost_usd;
  } catch {}
  const m = inner.match(/"total_cost_usd"\s*:\s*([0-9.eE+\-]+)/);
  return m ? parseFloat(m[1]) : undefined;
}

function uniqueRequestId(label: string): string {
  return `${label}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

async function spawnAndWait(
  runnerPath: string,
  runnerArgs: string[],
  env: Record<string, string>,
  cwd: string,
  outputFile: string,
  timeoutMs: number,
): Promise<{ ok: boolean; error?: string }> {
  return new Promise((resolve) => {
    const proc = spawn("python3", [runnerPath, outputFile, ...runnerArgs], {
      cwd,
      env,
      detached: false,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stderr = "";
    proc.stderr?.on("data", (d) => {
      stderr += d.toString();
    });
    // Drain stdout to prevent buffer fill, but don't store.
    proc.stdout?.on("data", () => {});

    const timer = setTimeout(() => {
      try {
        proc.kill("SIGTERM");
      } catch {}
      resolve({
        ok: false,
        error: `runner exceeded timeout ${timeoutMs}ms`,
      });
    }, timeoutMs);

    proc.on("exit", (code) => {
      clearTimeout(timer);
      if (code === 0 && existsSync(outputFile)) {
        resolve({ ok: true });
      } else {
        resolve({
          ok: false,
          error: `runner exit ${code}; stderr: ${stderr.slice(-300)}`,
        });
      }
    });

    proc.on("error", (err) => {
      clearTimeout(timer);
      resolve({ ok: false, error: `spawn error: ${err.message}` });
    });
  });
}

export async function runAgent(
  opts: SpawnAgentOptions,
): Promise<SpawnAgentResult> {
  const startedAt = Date.now();
  const { runtime, agentName, prompt, channelId } = opts;
  const timeoutMs = opts.timeoutMs ?? 5 * 60 * 1000;

  if (!existsSync(TEMP_DIR)) mkdirSync(TEMP_DIR, { recursive: true });
  const requestId = uniqueRequestId(`${runtime}-replay`);
  const outputFile = join(TEMP_DIR, `replay-${requestId}.json`);

  try {
    if (runtime === "claude") {
      const config = await buildClaudeConfig({
        channelId,
        prompt,
        agentName,
        sessionKey: `tier2-replay:${requestId}`,
        taskId: requestId,
        skipSessionResume: true,
      });
      const runnerPath = join(
        HARNESS_ROOT,
        "bridges",
        "discord",
        "claude-runner.py",
      );
      const result = await spawnAndWait(
        runnerPath,
        config.args,
        config.env,
        config.cwd,
        outputFile,
        timeoutMs,
      );
      if (!result.ok) {
        return {
          ok: false,
          responseText: null,
          durationMs: Date.now() - startedAt,
          error: result.error,
        };
      }
      const raw = readFileSync(outputFile, "utf-8");
      // claude-runner.py wraps output as {"stdout": "...", "stderr": "...",
      // "returncode": N}. Unwrap before handing to extractResponse, which
      // expects the raw stream-json/single-json that claude itself produced.
      let inner = raw;
      try {
        const envelope = JSON.parse(raw);
        if (typeof envelope?.stdout === "string") inner = envelope.stdout;
      } catch {
        // Not wrapped — pass through.
      }
      const responseText = extractResponse(inner);
      const costUsd = extractClaudeCostFromInner(inner);
      return {
        ok: responseText != null,
        responseText,
        durationMs: Date.now() - startedAt,
        rawOutputPath: outputFile,
        error: responseText == null ? "extractResponse returned null" : undefined,
        costUsd,
      };
    }

    // Codex
    const codexConfig = await buildCodexConfig({
      channelId,
      prompt,
      agentName,
      sessionKey: `tier2-replay:${requestId}`,
      taskId: requestId,
      outputFile,
      skipSessionResume: true,
    });
    // Codex runner takes the prompt via a file flag, not argv.
    const promptFile = join(TEMP_DIR, `prompt-${requestId}.txt`);
    writeFileSync(promptFile, codexConfig.prompt, "utf-8");
    const runnerPath = join(
      HARNESS_ROOT,
      "bridges",
      "discord",
      "codex-runner.py",
    );
    const args = ["--prompt-file", promptFile, ...codexConfig.runnerArgs];
    const result = await spawnAndWait(
      runnerPath,
      args,
      codexConfig.env,
      codexConfig.cwd,
      outputFile,
      timeoutMs,
    );
    try {
      unlinkSync(promptFile);
    } catch {}
    if (!result.ok) {
      return {
        ok: false,
        responseText: null,
        durationMs: Date.now() - startedAt,
        error: result.error,
      };
    }
    const raw = readFileSync(outputFile, "utf-8");
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (e) {
      return {
        ok: false,
        responseText: null,
        durationMs: Date.now() - startedAt,
        error: `codex output not JSON: ${(e as Error).message}`,
      };
    }
    // codex-runner.py also wraps output as {"stdout": "...", "stderr": "...",
    // "returncode": N}. extractCodexResponse expects the inner Codex JSON —
    // try the envelope first, then the raw.
    let inner: unknown = parsed;
    if (
      parsed &&
      typeof parsed === "object" &&
      typeof (parsed as { stdout?: unknown }).stdout === "string"
    ) {
      try {
        inner = JSON.parse((parsed as { stdout: string }).stdout);
      } catch {
        inner = parsed;
      }
    }
    const responseText = extractCodexResponse(inner);
    return {
      ok: responseText != null,
      responseText,
      durationMs: Date.now() - startedAt,
      rawOutputPath: outputFile,
      error: responseText == null ? "extractCodexResponse returned null" : undefined,
    };
  } catch (err) {
    return {
      ok: false,
      responseText: null,
      durationMs: Date.now() - startedAt,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

export function cleanupRawOutput(path: string | undefined): void {
  if (!path) return;
  try {
    unlinkSync(path);
  } catch {}
}
