/**
 * Handoff Transport Adapter
 *
 * Defines the minimal interface that handoff-router.ts needs from a transport.
 * This replaces the direct dependency on discord.js TextChannel.
 *
 * In Phase 5, handoff-router.ts will import from here instead of discord.js.
 * For now, bot.ts can create a HandoffTransport from a TextChannel.
 */

import type { GatewayMessage } from "./core-types.js";

/**
 * Minimal transport interface for handoff operations.
 * Subset of TransportAdapter focused on what handoff-router needs.
 */
export interface HandoffTransport {
  /** Channel/conversation ID */
  channelId: string;

  /** Send a message to the channel. Returns message ID. */
  send(text: string): Promise<string>;

  /** Show typing indicator. */
  sendTyping(): Promise<void>;

  /** Fetch recent messages for context building. */
  fetchRecentMessages(limit: number): Promise<HandoffMessage[]>;
}

/**
 * Simplified message format for handoff context building.
 * Replaces discord.js Message in buildProjectContext().
 */
export interface HandoffMessage {
  authorId: string;
  authorName: string;
  isBot: boolean;
  content: string;
  timestamp: number;
}

/**
 * Create a HandoffTransport from a discord.js TextChannel.
 * Used in bot.ts during Phase 5 transition.
 */
export function createDiscordHandoffTransport(channel: any): HandoffTransport {
  return {
    channelId: channel.id,

    async send(text: string): Promise<string> {
      try {
        const msg = await channel.send(text);
        return msg.id;
      } catch (err: any) {
        console.error(`[HANDOFF-TRANSPORT] Failed to send to ${channel.id}: ${err.message}`);
        throw err;
      }
    },

    async sendTyping(): Promise<void> {
      await channel.sendTyping();
    },

    async fetchRecentMessages(limit: number): Promise<HandoffMessage[]> {
      const messages = await channel.messages.fetch({ limit });
      return [...messages.values()].reverse().map((msg: any) => ({
        authorId: msg.author.id,
        authorName: msg.author.bot ? "bot" : msg.author.username,
        isBot: msg.author.bot,
        content: msg.content,
        timestamp: msg.createdTimestamp,
      }));
    },
  };
}
