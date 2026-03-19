#!/usr/bin/env npx tsx
/**
 * AI Harness Bot — v2 Entrypoint
 *
 * Thin entrypoint that wires Gateway (transport-agnostic orchestration)
 * with DiscordTransport (Discord adapter). This replaces the monolithic
 * bot.ts with a clean separation of concerns.
 *
 * Phase 6 of the Gateway abstraction.
 *
 * Usage:
 *   HARNESS_ROOT=/path/to/AI-Harness npx tsx bot-v2.ts
 */

import { config } from "dotenv";
import { existsSync, readFileSync, writeFileSync, unlinkSync } from "fs";
import { join } from "path";
import { Gateway } from "./core-gateway.js";
import { DiscordTransport } from "./discord-transport.js";
import { proc, onShutdown } from "./platform.js";

// Load environment variables
config();

// ─── Configuration ───────────────────────────────────────────────────

const HARNESS_ROOT = process.env.HARNESS_ROOT || ".";
const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
const ALLOWED_USER_IDS = (process.env.ALLOWED_USER_IDS || "").split(",").map(s => s.trim()).filter(Boolean);
const MAX_CONCURRENT = parseInt(process.env.MAX_CONCURRENT || "15", 10);
const PID_FILE = join(import.meta.dirname || ".", ".bot.pid");

if (!DISCORD_TOKEN) {
  console.error("DISCORD_TOKEN is required in .env");
  process.exit(1);
}

if (ALLOWED_USER_IDS.length === 0) {
  console.error("ALLOWED_USER_IDS is required in .env");
  process.exit(1);
}

// ─── PID File Guard ──────────────────────────────────────────────────

try {
  if (existsSync(PID_FILE)) {
    const oldPid = parseInt(readFileSync(PID_FILE, "utf-8").trim());
    if (proc.isAlive(oldPid)) {
      console.error(`Bot already running (PID ${oldPid}). Remove ${PID_FILE} to force.`);
      process.exit(1);
    } else {
      // Old process is dead — clean up stale PID file
      unlinkSync(PID_FILE);
    }
  }
  writeFileSync(PID_FILE, String(process.pid));
} catch (err: any) {
  console.error(`PID file error: ${err.message}`);
}

// ─── Create Transport + Gateway ──────────────────────────────────────

const transport = new DiscordTransport({
  token: DISCORD_TOKEN,
  allowedUserIds: ALLOWED_USER_IDS,
  harnessRoot: HARNESS_ROOT,
  maxConcurrent: MAX_CONCURRENT,
});

const gateway = new Gateway(transport, {
  maxConcurrent: MAX_CONCURRENT,
  harnessRoot: HARNESS_ROOT,
  allowedUserIds: ALLOWED_USER_IDS,
});

// Wire bidirectional references
transport.setGateway(gateway);

// Wire the post-output hook so the transport can handle handoffs,
// CREATE_CHANNEL directives, and orchestrator debriefs
if (typeof (transport as any).handlePostOutput === "function") {
  gateway.setPostOutputHook((transport as any).handlePostOutput.bind(transport));
}

// ─── Lifecycle ───────────────────────────────────────────────────────

async function start(): Promise<void> {
  console.log("AI Harness Bot v2 starting...");
  console.log(`  HARNESS_ROOT: ${HARNESS_ROOT}`);
  console.log(`  Allowed users: ${ALLOWED_USER_IDS.join(", ")}`);
  console.log(`  Max concurrent: ${MAX_CONCURRENT}`);

  // Start gateway first (registers task handlers, recovers crashed tasks)
  await gateway.start();

  // Start transport (connects to Discord, sets up channels, begins receiving messages)
  await transport.start();

  console.log("AI Harness Bot v2 ready.");
}

async function shutdown(): Promise<void> {
  console.log("\nShutting down...");
  await gateway.stop();
  await transport.stop();
  try { unlinkSync(PID_FILE); } catch {}
  console.log("Goodbye.");
  process.exit(0);
}

// ─── Signal Handlers ─────────────────────────────────────────────────

process.on("exit", () => {
  try { unlinkSync(PID_FILE); } catch {}
});
onShutdown(() => shutdown());
process.on("uncaughtException", (err) => {
  console.error("[FATAL] Uncaught exception:", err);
  try { unlinkSync(PID_FILE); } catch {}
  process.exit(1);
});

// ─── Start ───────────────────────────────────────────────────────────

start().catch((err) => {
  console.error("[FATAL] Startup failed:", err);
  try { unlinkSync(PID_FILE); } catch {}
  process.exit(1);
});
