/**
 * Claude usage-limit probe — the REAL quota data behind Claude Code's `/usage`.
 *
 * Claude Code (and claude.ai/settings/usage) fetch live quota from
 * `GET https://api.anthropic.com/api/oauth/usage` using the subscription OAuth
 * token. The response gives per-window `utilization` (%) + `resets_at` for the
 * 5-hour session window, the 7-day all-models window, and the 7-day Sonnet
 * window (verified by spike, 2026-05-27). This module replicates that call so
 * the control panel can show the same numbers — no scraping, no AI tokens.
 *
 * Token source: macOS Keychain item `Claude Code-credentials` (where Claude
 * Code stores the OAuth token), read via `security`. NOTE: this works from an
 * interactive shell; whether the launchd-spawned bot can read the Keychain
 * depends on the item ACL — if not, the probe degrades gracefully to
 * "unavailable" and the panel just shows that.
 *
 * No refresh-on-401 here: if the token is stale the GET 401s and we surface it;
 * Claude Code refreshes the Keychain token on its own usage. Best-effort.
 *
 * Codex has no clean equivalent — its `/api/codex/usage` is Cloudflare-gated and
 * rejects replicated requests; rate-limit data only flows through codex's own
 * client session. See the session notes / vault.
 */
import { execFileSync } from "child_process";
import { existsSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";

interface UsageWindow {
  utilization: number;
  resets_at: string | null;
}

export interface ClaudeUsage {
  five_hour?: UsageWindow | null;
  seven_day?: UsageWindow | null;
  seven_day_sonnet?: UsageWindow | null;
  extra_usage?: { used_credits?: number; monthly_limit?: number; currency?: string } | null;
  fetchedAt: number;
  error?: string;
}

const USAGE_ENDPOINT = "https://api.anthropic.com/api/oauth/usage";

let cacheFile = join(process.env.HARNESS_ROOT || ".", ".usage-limits.json");

// ─── Injectable seams (tests) ──────────────────────────────────────────────

export function setUsageLimitsFileForTests(path: string | null): void {
  cacheFile = path || join(process.env.HARNESS_ROOT || ".", ".usage-limits.json");
}

let readToken: () => string | null = defaultReadToken;
export function setUsageTokenReaderForTests(fn: (() => string | null) | null): void {
  readToken = fn || defaultReadToken;
}

interface HttpResp {
  ok: boolean;
  status: number;
  json: () => Promise<any>;
}
let httpGet: (url: string, headers: Record<string, string>) => Promise<HttpResp> = defaultHttpGet;
export function setUsageFetchForTests(
  fn: ((url: string, headers: Record<string, string>) => Promise<HttpResp>) | null,
): void {
  httpGet = fn || defaultHttpGet;
}

function defaultReadToken(): string | null {
  try {
    const raw = execFileSync(
      "security",
      ["find-generic-password", "-s", "Claude Code-credentials", "-w"],
      { encoding: "utf-8", timeout: 5000 },
    );
    return JSON.parse(raw)?.claudeAiOauth?.accessToken || null;
  } catch {
    return null;
  }
}

async function defaultHttpGet(url: string, headers: Record<string, string>): Promise<HttpResp> {
  const f = (globalThis as any).fetch;
  const AC = (globalThis as any).AbortController;
  const ctrl = new AC();
  const timer = setTimeout(() => ctrl.abort(), 12000);
  try {
    return await f(url, { headers, signal: ctrl.signal });
  } finally {
    clearTimeout(timer);
  }
}

// ─── Probe ──────────────────────────────────────────────────────────────────

function writeCache(data: ClaudeUsage): void {
  try {
    writeFileSync(cacheFile, JSON.stringify(data), "utf-8");
  } catch {
    /* best-effort */
  }
}

/** Fetch live usage, cache it, and return it. Never throws. */
export async function refreshClaudeUsage(): Promise<ClaudeUsage> {
  const token = readToken();
  if (!token) {
    const e: ClaudeUsage = { fetchedAt: Date.now(), error: "no-token (keychain unreadable?)" };
    writeCache(e);
    return e;
  }
  try {
    const res = await httpGet(USAGE_ENDPOINT, {
      Authorization: `Bearer ${token}`,
      "anthropic-beta": "oauth-2025-04-20",
      "anthropic-version": "2023-06-01",
      "User-Agent": "ai-harness-usage-probe",
    });
    if (!res.ok) {
      const e: ClaudeUsage = { fetchedAt: Date.now(), error: `http-${res.status}` };
      writeCache(e);
      return e;
    }
    const d = await res.json();
    const data: ClaudeUsage = {
      five_hour: d.five_hour ?? null,
      seven_day: d.seven_day ?? null,
      seven_day_sonnet: d.seven_day_sonnet ?? null,
      extra_usage: d.extra_usage ?? null,
      fetchedAt: Date.now(),
    };
    writeCache(data);
    return data;
  } catch (err: any) {
    const e: ClaudeUsage = {
      fetchedAt: Date.now(),
      error: err?.name === "AbortError" ? "timeout" : err?.message || "fetch-failed",
    };
    writeCache(e);
    return e;
  }
}

export function getCachedClaudeUsage(): ClaudeUsage | null {
  try {
    if (!existsSync(cacheFile)) return null;
    return JSON.parse(readFileSync(cacheFile, "utf-8")) as ClaudeUsage;
  } catch {
    return null;
  }
}

// ─── Formatting ───────────────────────────────────────────────────────────

function pct(w?: UsageWindow | null): string {
  return w && typeof w.utilization === "number" ? `${Math.round(w.utilization)}%` : "—";
}

function resetShort(w?: UsageWindow | null): string {
  if (!w?.resets_at) return "";
  try {
    const dt = new Date(w.resets_at);
    return ` (resets ${dt.toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })})`;
  } catch {
    return "";
  }
}

function ageMins(ms: number): number {
  return Math.floor((Date.now() - ms) / 60000);
}

/** One concise line for the control-panel dashboard. */
export function formatClaudeUsage(data: ClaudeUsage | null = getCachedClaudeUsage()): string {
  if (!data) return "not fetched — press Refresh";
  if (data.error) return `unavailable (${data.error})`;
  const parts = [
    `Session ${pct(data.five_hour)}${resetShort(data.five_hour)}`,
    `Week ${pct(data.seven_day)}`,
    `Sonnet ${pct(data.seven_day_sonnet)}`,
  ];
  const age = ageMins(data.fetchedAt);
  return `${parts.join(" · ")}${age > 2 ? ` _(${age}m ago)_` : ""}`;
}
