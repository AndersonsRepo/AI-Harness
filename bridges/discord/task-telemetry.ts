import { getDb } from "./db.js";

export interface TelemetrySummary {
  toolCalls: unknown[];
  totalTools: number;
  durationMs: number;
  estInputTokens: number;
  estOutputTokens: number;
  estCostCents: number;
  intervention: string | null;
}

export interface PersistTaskTelemetryInput {
  taskId: string;
  channelId: string;
  agent: string;
  prompt: string;
  status: string;
  error?: string | null;
  telemetry: TelemetrySummary;
}

export function persistTaskTelemetry(input: PersistTaskTelemetryInput): void {
  const db = getDb();
  db.prepare(`
    INSERT OR REPLACE INTO task_telemetry
    (task_id, channel_id, agent, prompt, started_at, completed_at, status, tool_calls, total_tools, duration_ms, est_input_tokens, est_output_tokens, est_cost_cents, intervention, error)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    input.taskId,
    input.channelId,
    input.agent,
    input.prompt.slice(0, 500),
    new Date(Date.now() - input.telemetry.durationMs).toISOString(),
    new Date().toISOString(),
    input.status,
    JSON.stringify(input.telemetry.toolCalls.slice(-50)),
    input.telemetry.totalTools,
    input.telemetry.durationMs,
    input.telemetry.estInputTokens,
    input.telemetry.estOutputTokens,
    input.telemetry.estCostCents,
    input.telemetry.intervention,
    input.error || null,
  );
}
