/**
 * Type Compliance Tests
 *
 * Validates that the TransportAdapter interface is correctly defined
 * and that implementations satisfy the contract at runtime.
 *
 * Run: npx tsx tests/types.test.ts
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type {
  TransportAdapter,
  GatewayMessage,
  GatewayConfig,
  PendingTaskEntry,
  CommandResult,
  EmbedPayload,
  EmbedField,
} from "../core-types.js";

// ─── Type Shape Tests ────────────────────────────────────────────────

describe("GatewayMessage — Shape", () => {
  it("has all required fields", () => {
    const msg: GatewayMessage = {
      id: "msg-1",
      channelId: "chan-1",
      userId: "user-1",
      text: "Hello",
      attachmentPaths: [],
      transportMeta: null,
    };
    assert.equal(msg.id, "msg-1");
    assert.equal(msg.channelId, "chan-1");
    assert.equal(msg.userId, "user-1");
    assert.equal(msg.text, "Hello");
    assert.deepEqual(msg.attachmentPaths, []);
    assert.equal(msg.transportMeta, null);
  });

  it("supports optional fields", () => {
    const msg: GatewayMessage = {
      id: "msg-2",
      channelId: "chan-1",
      userId: "user-1",
      text: "Hello",
      attachmentPaths: ["/tmp/image.png"],
      replyToId: "msg-1",
      guildId: "guild-1",
      transportMeta: { discordMessage: "opaque" },
    };
    assert.equal(msg.replyToId, "msg-1");
    assert.equal(msg.guildId, "guild-1");
    assert.equal(msg.attachmentPaths.length, 1);
  });

  it("transportMeta is truly opaque (any type)", () => {
    const msg1: GatewayMessage = { id: "1", channelId: "c", userId: "u", text: "", attachmentPaths: [], transportMeta: "string" };
    const msg2: GatewayMessage = { id: "2", channelId: "c", userId: "u", text: "", attachmentPaths: [], transportMeta: 42 };
    const msg3: GatewayMessage = { id: "3", channelId: "c", userId: "u", text: "", attachmentPaths: [], transportMeta: { complex: [1, 2] } };
    assert.equal(typeof msg1.transportMeta, "string");
    assert.equal(typeof msg2.transportMeta, "number");
    assert.equal(typeof msg3.transportMeta, "object");
  });
});

describe("EmbedPayload — Shape", () => {
  it("supports all optional fields", () => {
    const embed: EmbedPayload = {
      title: "Test",
      description: "A test embed",
      color: 0xFF0000,
      fields: [
        { name: "Field 1", value: "Value 1", inline: true },
        { name: "Field 2", value: "Value 2" },
      ],
      footer: "Footer text",
      timestamp: new Date(),
    };
    assert.equal(embed.title, "Test");
    assert.equal(embed.fields?.length, 2);
    assert.equal(embed.fields?.[0].inline, true);
    assert.equal(embed.fields?.[1].inline, undefined);
  });

  it("works with minimal fields", () => {
    const embed: EmbedPayload = {};
    assert.equal(embed.title, undefined);
    assert.equal(embed.fields, undefined);
  });
});

describe("GatewayConfig — Shape", () => {
  it("has all required fields", () => {
    const config: GatewayConfig = {
      maxConcurrent: 5,
      harnessRoot: "/path/to/harness",
      allowedUserIds: ["user-1", "user-2"],
    };
    assert.equal(config.maxConcurrent, 5);
    assert.equal(config.harnessRoot, "/path/to/harness");
    assert.equal(config.allowedUserIds.length, 2);
  });
});

describe("PendingTaskEntry — Shape", () => {
  it("has all required fields", () => {
    const entry: PendingTaskEntry = {
      originMessageId: "msg-1",
      channelId: "chan-1",
      userId: "user-1",
      userText: "Do something",
      streamDir: "/tmp/streams/123",
      isRetry: false,
      transportMeta: null,
    };
    assert.equal(entry.originMessageId, "msg-1");
    assert.equal(entry.isRetry, false);
    assert.equal(entry.agentName, undefined);
    assert.equal(entry.streamMessageId, undefined);
  });

  it("supports optional fields", () => {
    const entry: PendingTaskEntry = {
      originMessageId: "msg-1",
      channelId: "chan-1",
      userId: "user-1",
      userText: "Do something",
      agentName: "builder",
      streamDir: "/tmp/streams/123",
      isRetry: true,
      streamMessageId: "stream-msg-1",
      transportMeta: { discord: true },
    };
    assert.equal(entry.agentName, "builder");
    assert.equal(entry.streamMessageId, "stream-msg-1");
    assert.equal(entry.isRetry, true);
  });
});

describe("CommandResult — Shape", () => {
  it("supports text-only response", () => {
    const result: CommandResult = { text: "Done." };
    assert.equal(result.text, "Done.");
    assert.equal(result.embed, undefined);
    assert.equal(result.ephemeral, undefined);
  });

  it("supports embed + ephemeral", () => {
    const result: CommandResult = {
      text: "Here are the results",
      embed: { title: "Results", color: 0x00FF00 },
      ephemeral: true,
    };
    assert.ok(result.embed);
    assert.equal(result.ephemeral, true);
  });
});

describe("TransportAdapter — Contract Validation", () => {
  // Minimal implementation to verify the interface is implementable
  class MinimalTransport implements TransportAdapter {
    readonly name = "minimal";
    readonly maxMessageLength = 4096;

    async sendMessage(channelId: string, text: string): Promise<string> {
      return "msg-1";
    }
    async editMessage(): Promise<void> {}
    async deleteMessage(): Promise<void> {}
    async sendTyping(): Promise<void> {}
    async start(): Promise<void> {}
    async stop(): Promise<void> {}
  }

  it("minimal implementation satisfies the interface", () => {
    const transport: TransportAdapter = new MinimalTransport();
    assert.equal(transport.name, "minimal");
    assert.equal(transport.maxMessageLength, 4096);
  });

  it("optional methods are truly optional", () => {
    const transport: TransportAdapter = new MinimalTransport();
    assert.equal(transport.sendEmbed, undefined);
    assert.equal(transport.sendFile, undefined);
    assert.equal(transport.createChannel, undefined);
    assert.equal(transport.fetchRecentMessages, undefined);
    assert.equal(transport.resolveChannelByName, undefined);
  });

  // Full implementation to verify all optionals work
  class FullTransport implements TransportAdapter {
    readonly name = "full";
    readonly maxMessageLength = 2000;

    async sendMessage(): Promise<string> { return "msg-1"; }
    async editMessage(): Promise<void> {}
    async deleteMessage(): Promise<void> {}
    async sendTyping(): Promise<void> {}
    async sendEmbed(): Promise<string> { return "embed-1"; }
    async sendFile(): Promise<string> { return "file-1"; }
    async createChannel(): Promise<string> { return "chan-1"; }
    async fetchRecentMessages(): Promise<GatewayMessage[]> { return []; }
    resolveChannelByName(): string | null { return null; }
    async start(): Promise<void> {}
    async stop(): Promise<void> {}
  }

  it("full implementation with all optional methods", async () => {
    const transport: TransportAdapter = new FullTransport();
    const msgId = await transport.sendEmbed!("ch", {});
    assert.equal(msgId, "embed-1");
    const fileId = await transport.sendFile!("ch", Buffer.from("test"), "test.txt");
    assert.ok(fileId);
    const chanId = await transport.createChannel!("test");
    assert.equal(chanId, "chan-1");
    const messages = await transport.fetchRecentMessages!("ch", 10);
    assert.deepEqual(messages, []);
  });
});
