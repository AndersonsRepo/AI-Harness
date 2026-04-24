/**
 * Gateway Core Tests
 *
 * Tests the transport-agnostic orchestration layer.
 * Since Gateway depends on task-runner/db/etc., these tests run with
 * HARNESS_ROOT set and SQLite available (integration-style).
 *
 * Run: cd bridges/discord && HARNESS_ROOT=../.. npx tsx --test tests/gateway.test.ts
 */

import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, unlinkSync, existsSync } from "fs";
import { join } from "path";
import type {
  TransportAdapter,
  GatewayMessage,
  EmbedPayload,
} from "../core-types.js";
import { Gateway } from "../core-gateway.js";

// ─── Mock Transport Adapter ──────────────────────────────────────────

interface SendRecord {
  type: "send" | "edit" | "delete" | "typing" | "embed";
  channelId: string;
  messageId?: string;
  text?: string;
  replyToId?: string;
  embed?: EmbedPayload;
}

class MockTransport implements TransportAdapter {
  readonly name = "mock";
  readonly maxMessageLength = 2000;

  sent: SendRecord[] = [];
  channels = new Map<string, string>();
  private nextMsgId = 1;

  async sendMessage(channelId: string, text: string, replyToId?: string): Promise<string> {
    const id = `mock-msg-${this.nextMsgId++}`;
    this.sent.push({ type: "send", channelId, text, replyToId, messageId: id });
    return id;
  }

  async editMessage(channelId: string, messageId: string, text: string): Promise<void> {
    this.sent.push({ type: "edit", channelId, messageId, text });
  }

  async deleteMessage(channelId: string, messageId: string): Promise<void> {
    this.sent.push({ type: "delete", channelId, messageId });
  }

  async sendTyping(channelId: string): Promise<void> {
    this.sent.push({ type: "typing", channelId });
  }

  async sendEmbed(channelId: string, embed: EmbedPayload): Promise<string> {
    const id = `mock-embed-${this.nextMsgId++}`;
    this.sent.push({ type: "embed", channelId, embed, messageId: id });
    return id;
  }

  resolveChannelByName(name: string): string | null {
    return this.channels.get(name) || null;
  }

  async start(): Promise<void> {}
  async stop(): Promise<void> {}

  reset(): void {
    this.sent = [];
    this.nextMsgId = 1;
  }
}

function makeMessage(overrides: Partial<GatewayMessage> = {}): GatewayMessage {
  return {
    id: "msg-1",
    channelId: "chan-1",
    userId: "user-1",
    text: "Hello, Claude!",
    attachmentPaths: [],
    transportMeta: null,
    ...overrides,
  };
}

const HARNESS_ROOT = process.env.HARNESS_ROOT || join(import.meta.dirname || ".", "..", "..");

// ─── Message Splitting Tests ─────────────────────────────────────────

describe("Gateway — Message Splitting", () => {
  let transport: MockTransport;
  let gateway: Gateway;

  beforeEach(() => {
    transport = new MockTransport();
    gateway = new Gateway(transport, {
      maxConcurrent: 5,
      harnessRoot: HARNESS_ROOT,
      allowedUserIds: ["user-1"],
    });
  });

  it("returns single chunk for short messages", () => {
    const result = gateway.splitMessage("Hello world");
    assert.equal(result.length, 1);
    assert.equal(result[0], "Hello world");
  });

  it("splits long messages at line boundaries", () => {
    const lines = Array.from({ length: 100 }, (_, i) => `Line ${i}: ${"x".repeat(30)}`);
    const longText = lines.join("\n");
    const result = gateway.splitMessage(longText);
    assert.ok(result.length > 1, "Should produce multiple chunks");
    for (const chunk of result) {
      assert.ok(chunk.length <= 2000, `Chunk exceeds max length: ${chunk.length}`);
    }
  });

  it("preserves code blocks across splits", () => {
    const code = "```typescript\n" + "const x = 1;\n".repeat(200) + "```";
    const result = gateway.splitMessage(code);
    assert.ok(result.length > 1, "Should split long code block");
  });

  it("respects adapter max message length", () => {
    const smallTransport = new MockTransport();
    Object.defineProperty(smallTransport, "maxMessageLength", { value: 100 });
    const gw = new Gateway(smallTransport, {
      maxConcurrent: 5,
      harnessRoot: HARNESS_ROOT,
      allowedUserIds: [],
    });
    const result = gw.splitMessage("x".repeat(250));
    assert.ok(result.length >= 3);
    for (const chunk of result) {
      assert.ok(chunk.length <= 100, `Chunk exceeds limit: ${chunk.length}`);
    }
  });
});

// ─── Command Tests ───────────────────────────────────────────────────

describe("Gateway — Command Handling", () => {
  let transport: MockTransport;
  let gateway: Gateway;

  beforeEach(() => {
    transport = new MockTransport();
    gateway = new Gateway(transport, {
      maxConcurrent: 5,
      harnessRoot: HARNESS_ROOT,
      allowedUserIds: ["user-1"],
    });
  });

  it("/status returns session info", async () => {
    const result = await gateway.onCommand("chan-1", "status", [], makeMessage());
    assert.ok(result);
    assert.ok(result.text.toLowerCase().includes("session"));
  });

  it("/agents lists available agents", async () => {
    const result = await gateway.onCommand("chan-1", "agents", [], makeMessage());
    assert.ok(result);
    assert.ok(result.text.includes("agent"));
  });

  it("/stop with no running task", async () => {
    const result = await gateway.onCommand("chan-1", "stop", [], makeMessage());
    assert.ok(result);
    assert.equal(result.text, "Nothing running in this channel.");
  });

  it("/new clears session", async () => {
    const result = await gateway.onCommand("chan-1", "new", [], makeMessage());
    assert.ok(result);
    assert.ok(result.text.includes("Cleared") || result.text.includes("No active"));
  });

  it("unknown command returns null (pass through)", async () => {
    const result = await gateway.onCommand("chan-1", "foobar", [], makeMessage());
    assert.equal(result, null);
  });
});

// ─── User Filtering Tests ────────────────────────────────────────────

describe("Gateway — User Filtering", () => {
  let transport: MockTransport;
  let gateway: Gateway;

  beforeEach(() => {
    transport = new MockTransport();
    gateway = new Gateway(transport, {
      maxConcurrent: 5,
      harnessRoot: HARNESS_ROOT,
      allowedUserIds: ["user-1"],
    });
  });

  it("blocks unauthorized users", async () => {
    await gateway.onMessage(makeMessage({ userId: "hacker" }));
    assert.equal(transport.sent.length, 0);
  });

  it("blocks empty messages", async () => {
    await gateway.onMessage(makeMessage({ text: "" }));
    assert.equal(transport.sent.length, 0);
  });

  it("routes commands for authorized users", async () => {
    await gateway.onMessage(makeMessage({ text: "/status" }));
    assert.ok(transport.sent.length > 0, "Should respond to /status");
    assert.ok(transport.sent[0].text?.toLowerCase().includes("session"));
  });
});

// ─── Queue Management Tests ──────────────────────────────────────────

describe("Gateway — Queue Management", () => {
  let transport: MockTransport;
  let gateway: Gateway;

  beforeEach(() => {
    transport = new MockTransport();
    gateway = new Gateway(transport, {
      maxConcurrent: 5,
      harnessRoot: HARNESS_ROOT,
      allowedUserIds: ["user-1"],
    });
  });

  it("channels start inactive", () => {
    assert.equal(gateway.isChannelActive("chan-1"), false);
  });

  it("release is idempotent", () => {
    gateway.releaseChannel("chan-1");
    gateway.releaseChannel("chan-1");
    assert.equal(gateway.isChannelActive("chan-1"), false);
  });

  it("does not start multiple queued same-channel tasks from duplicate release calls", async () => {
    const executions: string[] = [];
    const enqueueTask = (gateway as any).enqueueTask.bind(gateway) as (channelId: string, task: { execute: () => void; message: GatewayMessage }) => boolean;

    enqueueTask("chan-1", {
      message: makeMessage({ id: "msg-a" }),
      execute: () => {
        executions.push("a");
      },
    });
    assert.deepEqual(executions, ["a"]);
    assert.equal(gateway.isChannelActive("chan-1"), true);

    enqueueTask("chan-1", {
      message: makeMessage({ id: "msg-b" }),
      execute: () => {
        executions.push("b");
      },
    });
    enqueueTask("chan-1", {
      message: makeMessage({ id: "msg-c" }),
      execute: () => {
        executions.push("c");
      },
    });

    gateway.releaseChannel("chan-1");
    assert.deepEqual(executions, ["a", "b"]);
    assert.equal(gateway.isChannelActive("chan-1"), true);

    // A second release for the same completed task should only advance one more
    // queued task, not unlock concurrent execution in the same channel.
    gateway.releaseChannel("chan-1");
    assert.deepEqual(executions, ["a", "b", "c"]);
    assert.equal(gateway.isChannelActive("chan-1"), true);
  });
});

// ─── Notification Drain Tests ────────────────────────────────────────

describe("Gateway — Notification Drain", () => {
  let transport: MockTransport;
  let gateway: Gateway;
  const testFile = "/tmp/gateway-test-notifications.jsonl";

  beforeEach(() => {
    transport = new MockTransport();
    transport.channels.set("notifications", "chan-notif");
    transport.channels.set("calendar", "chan-cal");
    gateway = new Gateway(transport, {
      maxConcurrent: 5,
      harnessRoot: HARNESS_ROOT,
      allowedUserIds: ["user-1"],
    });
    try { unlinkSync(testFile); } catch {}
  });

  it("returns 0 for nonexistent file", async () => {
    assert.equal(await gateway.drainNotifications("/tmp/nonexistent.jsonl"), 0);
  });

  it("returns 0 for empty file", async () => {
    writeFileSync(testFile, "");
    assert.equal(await gateway.drainNotifications(testFile), 0);
  });

  it("drains to correct channel", async () => {
    writeFileSync(testFile, JSON.stringify({
      task: "deploy-monitor",
      channel: "notifications",
      summary: "Deploy OK",
    }) + "\n");

    const count = await gateway.drainNotifications(testFile);
    assert.equal(count, 1);
    const embeds = transport.sent.filter(s => s.type === "embed");
    assert.equal(embeds.length, 1);
    assert.equal(embeds[0].channelId, "chan-notif");
  });

  it("skips unknown channels", async () => {
    writeFileSync(testFile, JSON.stringify({
      task: "test",
      channel: "nonexistent",
      summary: "Test",
    }) + "\n");

    assert.equal(await gateway.drainNotifications(testFile), 0);
  });

  it("handles multiple notifications", async () => {
    const lines = [
      JSON.stringify({ task: "a", channel: "notifications", summary: "A" }),
      JSON.stringify({ task: "b", channel: "calendar", summary: "B" }),
      JSON.stringify({ task: "c", channel: "unknown", summary: "C" }),
    ].join("\n");
    writeFileSync(testFile, lines);

    const count = await gateway.drainNotifications(testFile);
    assert.equal(count, 2, "Should drain 2 (skip unknown channel)");
  });

  it("clears file after drain", async () => {
    writeFileSync(testFile, JSON.stringify({
      task: "test",
      channel: "notifications",
      summary: "Test",
    }) + "\n");

    await gateway.drainNotifications(testFile);
    // File should be cleared
    const { readFileSync: readFS } = await import("fs");
    const content = existsSync(testFile) ? readFS(testFile, "utf-8") : "";
    assert.equal(content, "");
  });
});
