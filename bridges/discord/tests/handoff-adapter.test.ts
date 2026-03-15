/**
 * Handoff Adapter Tests
 *
 * Tests the HandoffTransport interface and mock implementations.
 *
 * Run: cd bridges/discord && HARNESS_ROOT=../.. npx tsx --test tests/handoff-adapter.test.ts
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { HandoffTransport, HandoffMessage } from "../handoff-adapter.js";

// ─── Mock HandoffTransport ───────────────────────────────────────────

class MockHandoffTransport implements HandoffTransport {
  channelId = "test-chan-1";
  sent: string[] = [];
  typingCalled = false;
  messages: HandoffMessage[] = [];

  async send(text: string): Promise<string> {
    this.sent.push(text);
    return `msg-${this.sent.length}`;
  }

  async sendTyping(): Promise<void> {
    this.typingCalled = true;
  }

  async fetchRecentMessages(limit: number): Promise<HandoffMessage[]> {
    return this.messages.slice(-limit);
  }
}

// ─── Tests ───────────────────────────────────────────────────────────

describe("HandoffTransport — Interface Compliance", () => {
  it("implements required interface", () => {
    const transport: HandoffTransport = new MockHandoffTransport();
    assert.equal(typeof transport.channelId, "string");
    assert.equal(typeof transport.send, "function");
    assert.equal(typeof transport.sendTyping, "function");
    assert.equal(typeof transport.fetchRecentMessages, "function");
  });

  it("send returns message IDs", async () => {
    const transport = new MockHandoffTransport();
    const id1 = await transport.send("hello");
    const id2 = await transport.send("world");
    assert.notEqual(id1, id2);
    assert.equal(transport.sent.length, 2);
  });

  it("sendTyping sets flag", async () => {
    const transport = new MockHandoffTransport();
    assert.equal(transport.typingCalled, false);
    await transport.sendTyping();
    assert.equal(transport.typingCalled, true);
  });

  it("fetchRecentMessages returns messages", async () => {
    const transport = new MockHandoffTransport();
    transport.messages = [
      { authorId: "u1", authorName: "user1", isBot: false, content: "Hello", timestamp: Date.now() - 5000 },
      { authorId: "b1", authorName: "bot", isBot: true, content: "Hi there", timestamp: Date.now() - 3000 },
      { authorId: "u1", authorName: "user1", isBot: false, content: "Thanks", timestamp: Date.now() },
    ];

    const all = await transport.fetchRecentMessages(10);
    assert.equal(all.length, 3);
    assert.equal(all[0].authorName, "user1");
    assert.equal(all[1].isBot, true);
  });

  it("fetchRecentMessages respects limit", async () => {
    const transport = new MockHandoffTransport();
    transport.messages = Array.from({ length: 20 }, (_, i) => ({
      authorId: "u1",
      authorName: "user",
      isBot: false,
      content: `Message ${i}`,
      timestamp: Date.now() - (20 - i) * 1000,
    }));

    const limited = await transport.fetchRecentMessages(5);
    assert.equal(limited.length, 5);
    assert.equal(limited[0].content, "Message 15");
  });
});

describe("HandoffMessage — Shape", () => {
  it("has all required fields", () => {
    const msg: HandoffMessage = {
      authorId: "user-1",
      authorName: "Anderson",
      isBot: false,
      content: "Hello",
      timestamp: Date.now(),
    };
    assert.equal(msg.authorId, "user-1");
    assert.equal(msg.isBot, false);
    assert.ok(msg.timestamp > 0);
  });

  it("distinguishes bot from user messages", () => {
    const userMsg: HandoffMessage = { authorId: "u", authorName: "user", isBot: false, content: "hi", timestamp: 0 };
    const botMsg: HandoffMessage = { authorId: "b", authorName: "bot", isBot: true, content: "hello", timestamp: 0 };
    assert.equal(userMsg.isBot, false);
    assert.equal(botMsg.isBot, true);
  });
});
