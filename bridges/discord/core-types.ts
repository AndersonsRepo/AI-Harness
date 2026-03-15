/**
 * Transport-agnostic types for the AI Harness Gateway.
 *
 * These define the contract between the orchestration core (gateway.ts)
 * and transport adapters (Discord, iMessage, web, etc.).
 *
 * Design principles:
 * - `transportMeta` is opaque — the core never reads it, only the adapter does
 * - Optional methods (sendEmbed, createChannel) allow transports with limited features
 * - Message IDs are strings — each transport uses its own ID format
 */

// ─── Message Types ───────────────────────────────────────────────────

export interface GatewayMessage {
  /** Unique message ID assigned by the transport */
  id: string;
  /** Channel/conversation identifier */
  channelId: string;
  /** Sender identifier */
  userId: string;
  /** Raw text content */
  text: string;
  /** Local file paths for downloaded attachments (images, files) */
  attachmentPaths: string[];
  /** Message this replies to, if any */
  replyToId?: string;
  /** Server/workspace ID, if applicable (e.g., Discord guild) */
  guildId?: string;
  /** Opaque transport-specific data (Discord Message, iMessage handle, etc.) */
  transportMeta: unknown;
}

// ─── Embed Types ─────────────────────────────────────────────────────

export interface EmbedField {
  name: string;
  value: string;
  inline?: boolean;
}

export interface EmbedPayload {
  title?: string;
  description?: string;
  color?: number;
  fields?: EmbedField[];
  footer?: string;
  timestamp?: Date;
}

// ─── Channel Creation ────────────────────────────────────────────────

export interface ChannelCreateOpts {
  parentCategory?: string;
  topic?: string;
  agent?: string;
}

// ─── Transport Adapter Interface ─────────────────────────────────────

export interface TransportAdapter {
  /** Transport identifier (e.g., "discord", "imessage", "web") */
  readonly name: string;

  /** Maximum message length for this transport (e.g., 1900 for Discord) */
  readonly maxMessageLength: number;

  // ─── Send Operations ─────────────────────────────────────────────

  /** Send a text message to a channel. Returns the message ID. */
  sendMessage(channelId: string, text: string, replyToId?: string): Promise<string>;

  /** Edit an existing message. */
  editMessage(channelId: string, messageId: string, text: string): Promise<void>;

  /** Delete a message. */
  deleteMessage(channelId: string, messageId: string): Promise<void>;

  /** Show typing indicator in a channel. */
  sendTyping(channelId: string): Promise<void>;

  // ─── Rich Content (optional) ─────────────────────────────────────

  /** Send an embed/rich message. Returns message ID. Not all transports support this. */
  sendEmbed?(channelId: string, embed: EmbedPayload): Promise<string>;

  /** Send a file/buffer. Returns message ID. */
  sendFile?(channelId: string, buffer: Buffer, filename: string): Promise<string>;

  // ─── Channel Management (optional) ───────────────────────────────

  /** Create a channel. Returns channelId. Not all transports have channels. */
  createChannel?(name: string, opts?: ChannelCreateOpts): Promise<string>;

  /** Fetch recent messages from a channel. Used by handoff context builder. */
  fetchRecentMessages?(channelId: string, limit: number): Promise<GatewayMessage[]>;

  /** Resolve a channel by name. Returns channelId or null. */
  resolveChannelByName?(name: string): string | null;

  // ─── Lifecycle ───────────────────────────────────────────────────

  /** Start the transport (connect to service, begin receiving messages). */
  start(): Promise<void>;

  /** Stop the transport (disconnect, clean up). */
  stop(): Promise<void>;
}

// ─── Gateway Config ──────────────────────────────────────────────────

export interface GatewayConfig {
  maxConcurrent: number;
  harnessRoot: string;
  allowedUserIds: string[];
}

// ─── Command Types ───────────────────────────────────────────────────

export interface CommandResult {
  text: string;
  embed?: EmbedPayload;
  /** If true, only the command sender should see this (Discord ephemeral, etc.) */
  ephemeral?: boolean;
}

// ─── Task Context (replaces PendingTaskContext) ──────────────────────

export interface PendingTaskEntry {
  /** Message ID from the transport (for reply threading) */
  originMessageId: string;
  /** Channel where the task was triggered */
  channelId: string;
  /** User who triggered the task */
  userId: string;
  /** Original user text */
  userText: string;
  /** Agent handling this task */
  agentName?: string;
  /** Stream directory for this task's stream-json chunks */
  streamDir: string;
  /** Whether this is a retry */
  isRetry: boolean;
  /** ID of the streaming progress message (updated in-place) */
  streamMessageId?: string;
  /** Opaque transport-specific data for this message */
  transportMeta: unknown;
}
