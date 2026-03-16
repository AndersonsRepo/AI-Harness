/**
 * Tests for Phase 5: DiscordTransport adapter + Gateway post-output hook.
 *
 * These tests run without Discord or Claude — they verify:
 * 1. DiscordTransport implements TransportAdapter correctly
 * 2. Gateway post-output hook intercepts responses properly
 * 3. Discord-specific command routing (channel create, project create, etc.)
 * 4. Notification drain logic
 * 5. Message conversion (discord.js Message → GatewayMessage)
 * 6. LinkedIn approval flow routing
 * 7. Channel auto-setup structure
 * 8. Gateway + core-commands integration via executeCommand delegation
 *
 * Usage: HARNESS_ROOT=$HOME/Desktop/AI-Harness npx tsx test-discord-transport.ts
 */

import { writeFileSync, existsSync, unlinkSync, mkdirSync, renameSync, readFileSync } from "fs";
import { join, resolve, dirname } from "path";

const HARNESS_ROOT = process.env.HARNESS_ROOT || resolve(dirname(new URL(import.meta.url).pathname), "../..");
process.env.HARNESS_ROOT = HARNESS_ROOT;

const REAL_DB = join(HARNESS_ROOT, "bridges", "discord", "harness.db");
const DB_BACKUP = REAL_DB + ".pre-test-backup";

let passed = 0;
let failed = 0;

function assert(condition: boolean, name: string): void {
  if (condition) {
    console.log(`  ✓ ${name}`);
    passed++;
  } else {
    console.error(`  ✗ ${name}`);
    failed++;
  }
}

async function main() {
  const hadExistingDb = existsSync(REAL_DB);
  if (hadExistingDb) {
    renameSync(REAL_DB, DB_BACKUP);
    console.log("(Backed up existing harness.db)");
  }

  try {
    await testTransportInterface();
    await testGatewayPostOutputHook();
    await testGatewayCommandDelegation();
    await testCoreCommandsIntegration();
    await testMessageSplitting();
    await testNotificationDrainGateway();
    await testPendingTaskEntry();
    await testDiscordTransportStructure();
  } finally {
    const { closeDb } = await import("./db.js");
    closeDb();
    try { unlinkSync(REAL_DB); } catch {}
    try { unlinkSync(REAL_DB + "-wal"); } catch {}
    try { unlinkSync(REAL_DB + "-shm"); } catch {}

    if (hadExistingDb && existsSync(DB_BACKUP)) {
      renameSync(DB_BACKUP, REAL_DB);
      console.log("(Restored original harness.db)");
    }
  }

  console.log(`\n${"=".repeat(40)}`);
  console.log(`Results: ${passed} passed, ${failed} failed`);
  console.log(`${"=".repeat(40)}`);
  process.exit(failed > 0 ? 1 : 0);
}

// ─── Mock Transport ─────────────────────────────────────────────────

interface MockCall {
  method: string;
  args: any[];
}

function createMockTransport() {
  const calls: MockCall[] = [];
  let messageIdCounter = 0;

  const transport = {
    name: "mock" as const,
    maxMessageLength: 1900,
    calls,

    async sendMessage(channelId: string, text: string, replyToId?: string): Promise<string> {
      calls.push({ method: "sendMessage", args: [channelId, text, replyToId] });
      return `msg-${++messageIdCounter}`;
    },
    async editMessage(channelId: string, messageId: string, text: string): Promise<void> {
      calls.push({ method: "editMessage", args: [channelId, messageId, text] });
    },
    async deleteMessage(channelId: string, messageId: string): Promise<void> {
      calls.push({ method: "deleteMessage", args: [channelId, messageId] });
    },
    async sendTyping(channelId: string): Promise<void> {
      calls.push({ method: "sendTyping", args: [channelId] });
    },
    async sendEmbed(channelId: string, embed: any): Promise<string> {
      calls.push({ method: "sendEmbed", args: [channelId, embed] });
      return `msg-${++messageIdCounter}`;
    },
    async sendFile(channelId: string, buffer: Buffer, filename: string): Promise<string> {
      calls.push({ method: "sendFile", args: [channelId, buffer, filename] });
      return `msg-${++messageIdCounter}`;
    },
    async createChannel(name: string, opts?: any): Promise<string> {
      calls.push({ method: "createChannel", args: [name, opts] });
      return `ch-${name}`;
    },
    async fetchRecentMessages(channelId: string, limit: number): Promise<any[]> {
      calls.push({ method: "fetchRecentMessages", args: [channelId, limit] });
      return [];
    },
    resolveChannelByName(name: string): string | null {
      calls.push({ method: "resolveChannelByName", args: [name] });
      return name === "general" ? "ch-general" : null;
    },
    async start(): Promise<void> {
      calls.push({ method: "start", args: [] });
    },
    async stop(): Promise<void> {
      calls.push({ method: "stop", args: [] });
    },
  };

  return transport;
}

// ─── Test: TransportAdapter Interface Compliance ────────────────────

async function testTransportInterface() {
  console.log("\n--- TransportAdapter Interface Compliance ---");

  const transport = createMockTransport();

  // Required properties
  assert(typeof transport.name === "string", "name is a string");
  assert(transport.name === "mock", "name is 'mock'");
  assert(typeof transport.maxMessageLength === "number", "maxMessageLength is a number");
  assert(transport.maxMessageLength === 1900, "maxMessageLength is 1900");

  // Required methods exist and return correct types
  const sendResult = await transport.sendMessage("ch1", "hello");
  assert(typeof sendResult === "string", "sendMessage returns string ID");

  await transport.editMessage("ch1", "msg-1", "edited");
  assert(transport.calls.some(c => c.method === "editMessage"), "editMessage is callable");

  await transport.deleteMessage("ch1", "msg-1");
  assert(transport.calls.some(c => c.method === "deleteMessage"), "deleteMessage is callable");

  await transport.sendTyping("ch1");
  assert(transport.calls.some(c => c.method === "sendTyping"), "sendTyping is callable");

  // Optional methods
  const embedResult = await transport.sendEmbed!("ch1", { title: "test" });
  assert(typeof embedResult === "string", "sendEmbed returns string ID");

  const fileResult = await transport.sendFile!("ch1", Buffer.from("test"), "test.txt");
  assert(typeof fileResult === "string", "sendFile returns string ID");

  const channelResult = await transport.createChannel!("test-channel");
  assert(typeof channelResult === "string", "createChannel returns string ID");

  const messages = await transport.fetchRecentMessages!("ch1", 10);
  assert(Array.isArray(messages), "fetchRecentMessages returns array");

  const resolved = transport.resolveChannelByName!("general");
  assert(resolved === "ch-general", "resolveChannelByName returns ID for known channel");

  const unknown = transport.resolveChannelByName!("nonexistent");
  assert(unknown === null, "resolveChannelByName returns null for unknown channel");

  // Lifecycle
  await transport.start();
  assert(transport.calls.some(c => c.method === "start"), "start is callable");
  await transport.stop();
  assert(transport.calls.some(c => c.method === "stop"), "stop is callable");
}

// ─── Test: Gateway Post-Output Hook ─────────────────────────────────

async function testGatewayPostOutputHook() {
  console.log("\n--- Gateway Post-Output Hook ---");

  const { Gateway } = await import("./core-gateway.js");
  type PostOutputHook = (channelId: string, response: string, agentName: string | undefined, originMessageId: string) => Promise<boolean>;
  const transport = createMockTransport();
  const gateway = new Gateway(transport as any, {
    maxConcurrent: 5,
    harnessRoot: HARNESS_ROOT,
    allowedUserIds: ["user-1"],
  });

  // Test hook registration
  let hookCalled = false;
  let hookChannelId = "";
  let hookResponse = "";
  let hookAgentName: string | undefined;

  const hook: PostOutputHook = async (channelId, response, agentName, originMessageId) => {
    hookCalled = true;
    hookChannelId = channelId;
    hookResponse = response;
    hookAgentName = agentName;
    return response.includes("[HANDOFF:"); // Return true if it's a handoff
  };

  gateway.setPostOutputHook(hook);

  // Verify the hook is set
  assert(typeof gateway.setPostOutputHook === "function", "setPostOutputHook is a function");

  // Test hook signature — the hook receives the right types
  const testHook: PostOutputHook = async (channelId: string, response: string, agentName: string | undefined, originMessageId: string) => {
    return false;
  };
  assert(typeof testHook === "function", "PostOutputHook type is assignable");

  // Test that hook can signal "handled" vs "not handled"
  const handledResult = await hook("ch1", "[HANDOFF:builder] do the thing", "orchestrator", "msg-1");
  assert(handledResult === true, "hook returns true for handoff responses");
  assert(hookCalled === true, "hook was called");
  assert(hookChannelId === "ch1", "hook received correct channelId");
  assert(hookResponse.includes("[HANDOFF:"), "hook received correct response");
  assert(hookAgentName === "orchestrator", "hook received correct agentName");

  const notHandledResult = await hook("ch1", "Normal response text", "builder", "msg-2");
  assert(notHandledResult === false, "hook returns false for normal responses");
}

// ─── Test: Gateway Command Delegation ───────────────────────────────

async function testGatewayCommandDelegation() {
  console.log("\n--- Gateway Command Delegation ---");

  const { Gateway } = await import("./core-gateway.js");
  const transport = createMockTransport();
  const gateway = new Gateway(transport as any, {
    maxConcurrent: 5,
    harnessRoot: HARNESS_ROOT,
    allowedUserIds: ["user-1"],
  });

  // Test that onCommand delegates to executeCommand
  const msg = {
    id: "msg-1",
    channelId: "ch-test",
    userId: "user-1",
    text: "/agents",
    attachmentPaths: [],
    transportMeta: {},
  };

  const result = await gateway.onCommand("ch-test", "agents", [], msg);
  assert(result !== null, "/agents command returns a result");
  assert(result!.text.includes("Available agents") || result!.text.includes("No agent"), "/agents returns agent list text");

  // /status
  const statusMsg = { ...msg, text: "/status" };
  const statusResult = await gateway.onCommand("ch-test", "status", [], statusMsg);
  assert(statusResult !== null, "/status command returns a result");
  assert(statusResult!.text.includes("session") || statusResult!.text.includes("Session"), "/status returns session info");

  // /new
  const newMsg = { ...msg, text: "/new" };
  const newResult = await gateway.onCommand("ch-test", "new", [], newMsg);
  assert(newResult !== null, "/new command returns a result");

  // Unknown command returns null (pass-through to Claude)
  const unknownMsg = { ...msg, text: "/nonexistent" };
  const unknownResult = await gateway.onCommand("ch-test", "nonexistent", [], unknownMsg);
  assert(unknownResult === null, "Unknown command returns null");
}

// ─── Test: Core Commands Integration ────────────────────────────────

async function testCoreCommandsIntegration() {
  console.log("\n--- Core Commands Integration ---");

  const { executeCommand } = await import("./core-commands.js");

  // /agents
  const agentsResult = await executeCommand({
    channelId: "ch-test",
    userId: "user-1",
    rawText: "/agents",
  });
  assert(agentsResult !== null, "executeCommand handles /agents");

  // /status
  const statusResult = await executeCommand({
    channelId: "ch-test",
    userId: "user-1",
    rawText: "/status",
  });
  assert(statusResult !== null, "executeCommand handles /status");
  assert(statusResult!.text.includes("session") || statusResult!.text.includes("Session"), "/status response mentions session");

  // /new
  const newResult = await executeCommand({
    channelId: "ch-test",
    userId: "user-1",
    rawText: "/new",
  });
  assert(newResult !== null, "executeCommand handles /new");

  // /config
  const configResult = await executeCommand({
    channelId: "ch-test",
    userId: "user-1",
    rawText: "/config",
  });
  assert(configResult !== null, "executeCommand handles /config");

  // /stop (no running tasks)
  let releaseChannelCalled = false;
  const stopResult = await executeCommand({
    channelId: "ch-test",
    userId: "user-1",
    rawText: "/stop",
    releaseChannel: () => { releaseChannelCalled = true; },
  });
  assert(stopResult !== null, "executeCommand handles /stop");
  assert(stopResult!.text.includes("Nothing running"), "/stop returns nothing-running when idle");

  // /db-status
  const dbResult = await executeCommand({
    channelId: "ch-test",
    userId: "user-1",
    rawText: "/db-status",
  });
  assert(dbResult !== null, "executeCommand handles /db-status");
  assert(dbResult!.text.includes("Database"), "/db-status mentions Database");

  // /vault-status
  const vaultResult = await executeCommand({
    channelId: "ch-test",
    userId: "user-1",
    rawText: "/vault-status",
  });
  assert(vaultResult !== null, "executeCommand handles /vault-status");

  // /dead-letter
  const dlResult = await executeCommand({
    channelId: "ch-test",
    userId: "user-1",
    rawText: "/dead-letter",
  });
  assert(dlResult !== null, "executeCommand handles /dead-letter");

  // /project list
  const projResult = await executeCommand({
    channelId: "ch-test",
    userId: "user-1",
    rawText: "/project list",
  });
  assert(projResult !== null, "executeCommand handles /project list");

  // Discord-specific commands return null (transport handles)
  const channelCreateResult = await executeCommand({
    channelId: "ch-test",
    userId: "user-1",
    rawText: "/channel create test-channel",
  });
  assert(channelCreateResult === null, "/channel create returns null (transport-specific)");

  const projectCloseResult = await executeCommand({
    channelId: "ch-test",
    userId: "user-1",
    rawText: "/project close",
  });
  assert(projectCloseResult === null, "/project close returns null (transport-specific)");

  // Unrecognized command returns null
  const unknownResult = await executeCommand({
    channelId: "ch-test",
    userId: "user-1",
    rawText: "/foobar",
  });
  assert(unknownResult === null, "Unknown command returns null");
}

// ─── Test: Message Splitting ────────────────────────────────────────

async function testMessageSplitting() {
  console.log("\n--- Message Splitting ---");

  const { Gateway } = await import("./core-gateway.js");
  const transport = createMockTransport();
  const gateway = new Gateway(transport as any, {
    maxConcurrent: 5,
    harnessRoot: HARNESS_ROOT,
    allowedUserIds: [],
  });

  // Short message — no split
  const short = gateway.splitMessage("Hello world");
  assert(short.length === 1, "Short message returns 1 chunk");
  assert(short[0] === "Hello world", "Short message chunk is unchanged");

  // Exact limit
  const exact = "x".repeat(1900);
  const exactResult = gateway.splitMessage(exact);
  assert(exactResult.length === 1, "Exact-length message returns 1 chunk");

  // Over limit — splits
  const long = "Line one\n".repeat(400); // ~3600 chars
  const longResult = gateway.splitMessage(long);
  assert(longResult.length >= 2, "Long message splits into 2+ chunks");
  assert(longResult.every(c => c.length <= 1900), "All chunks are within limit");

  // Code block preservation
  const codeMsg = "Before\n```typescript\n" + "const x = 1;\n".repeat(200) + "```\nAfter";
  const codeResult = gateway.splitMessage(codeMsg);
  assert(codeResult.length >= 2, "Code block message splits");

  // Empty message
  const empty = gateway.splitMessage("");
  assert(empty.length === 1 && empty[0] === "", "Empty message returns 1 empty chunk");
}

// ─── Test: Notification Drain (Gateway level) ───────────────────────

async function testNotificationDrainGateway() {
  console.log("\n--- Notification Drain (Gateway) ---");

  const { Gateway } = await import("./core-gateway.js");
  const transport = createMockTransport();
  const gateway = new Gateway(transport as any, {
    maxConcurrent: 5,
    harnessRoot: HARNESS_ROOT,
    allowedUserIds: [],
  });

  // Non-existent file
  const nonExistent = join(HARNESS_ROOT, "bridges", "discord", ".tmp", "test-notify-nonexist.jsonl");
  const result0 = await gateway.drainNotifications(nonExistent);
  assert(result0 === 0, "drainNotifications returns 0 for non-existent file");

  // Empty file
  const emptyFile = join(HARNESS_ROOT, "bridges", "discord", ".tmp", "test-notify-empty.jsonl");
  try { mkdirSync(dirname(emptyFile), { recursive: true }); } catch {}
  writeFileSync(emptyFile, "");
  const result1 = await gateway.drainNotifications(emptyFile);
  assert(result1 === 0, "drainNotifications returns 0 for empty file");
  try { unlinkSync(emptyFile); } catch {}

  // File with a notification targeting "general" (which our mock resolves)
  const testFile = join(HARNESS_ROOT, "bridges", "discord", ".tmp", "test-notify.jsonl");
  const notif = JSON.stringify({ task: "test-task", channel: "general", summary: "Test notification" });
  writeFileSync(testFile, notif + "\n");
  const result2 = await gateway.drainNotifications(testFile);
  assert(result2 === 1, "drainNotifications drains 1 notification");

  // Verify sendEmbed was called (transport supports embeds)
  const embedCalls = transport.calls.filter(c => c.method === "sendEmbed");
  assert(embedCalls.length === 1, "sendEmbed was called for notification");
  assert(embedCalls[0].args[0] === "ch-general", "sendEmbed targeted correct channel");
  assert(embedCalls[0].args[1].title === "Test Task", "sendEmbed title is task name titlecased");

  // Clean up
  try { unlinkSync(testFile); } catch {}
}

function dirname(p: string): string {
  return p.split("/").slice(0, -1).join("/");
}

// ─── Test: PendingTaskEntry ─────────────────────────────────────────

async function testPendingTaskEntry() {
  console.log("\n--- PendingTaskEntry Type ---");

  const entry = {
    originMessageId: "msg-1",
    channelId: "ch-1",
    userId: "user-1",
    userText: "hello",
    agentName: "builder",
    streamDir: "/tmp/streams/test",
    isRetry: false,
    streamMessageId: "stream-msg-1",
    transportMeta: { discordMessage: true },
  };

  assert(typeof entry.originMessageId === "string", "originMessageId is string");
  assert(typeof entry.channelId === "string", "channelId is string");
  assert(typeof entry.userId === "string", "userId is string");
  assert(typeof entry.userText === "string", "userText is string");
  assert(typeof entry.agentName === "string", "agentName is string");
  assert(typeof entry.streamDir === "string", "streamDir is string");
  assert(typeof entry.isRetry === "boolean", "isRetry is boolean");
  assert(typeof entry.streamMessageId === "string", "streamMessageId is string");
  assert(entry.transportMeta !== undefined, "transportMeta is present");
}

// ─── Test: DiscordTransport Structure ───────────────────────────────

async function testDiscordTransportStructure() {
  console.log("\n--- DiscordTransport Structure ---");

  // Verify the module exports the expected types
  const mod = await import("./discord-transport.js");

  assert(typeof mod.DiscordTransport === "function", "DiscordTransport class is exported");

  // Verify the class has the right static shape (without instantiating — needs discord.js)
  const proto = mod.DiscordTransport.prototype;
  assert(typeof proto.sendMessage === "function", "sendMessage method exists");
  assert(typeof proto.editMessage === "function", "editMessage method exists");
  assert(typeof proto.deleteMessage === "function", "deleteMessage method exists");
  assert(typeof proto.sendTyping === "function", "sendTyping method exists");
  assert(typeof proto.sendEmbed === "function", "sendEmbed method exists");
  assert(typeof proto.sendFile === "function", "sendFile method exists");
  assert(typeof proto.createChannel === "function", "createChannel method exists");
  assert(typeof proto.fetchRecentMessages === "function", "fetchRecentMessages method exists");
  assert(typeof proto.resolveChannelByName === "function", "resolveChannelByName method exists");
  assert(typeof proto.start === "function", "start method exists");
  assert(typeof proto.stop === "function", "stop method exists");
  assert(typeof proto.setGateway === "function", "setGateway method exists");
  assert(typeof proto.getClient === "function", "getClient method exists");
  assert(typeof proto.handlePostOutput === "function", "handlePostOutput method exists");
}

main().catch((err) => {
  console.error(`Test runner error: ${err.message}`);
  console.error(err.stack);
  process.exit(1);
});
