#!/usr/bin/env node
/**
 * MCP LinkedIn Server
 *
 * Draft→approve→publish flow for LinkedIn posts. The calling agent generates
 * content (non-deterministic). This server handles storage, approval tokens,
 * and API publishing (all deterministic).
 *
 * All LinkedIn API requests use direct fetch() — no SDK dependency.
 *
 * IMPORTANT: Never use console.log — it corrupts the JSON-RPC stream.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import Database from "better-sqlite3";
import { existsSync, appendFileSync } from "fs";
import { join } from "path";
import { randomBytes } from "crypto";

// ─── Configuration ───────────────────────────────────────────────────

const HARNESS_ROOT = process.env.HARNESS_ROOT || ".";
const DB_PATH = join(HARNESS_ROOT, "bridges", "discord", "harness.db");
const NOTIFY_FILE = join(HARNESS_ROOT, "heartbeat-tasks", "pending-notifications.jsonl");

// LinkedIn API version — update monthly
const LINKEDIN_VERSION = "202505";

// ─── Database ────────────────────────────────────────────────────────

let db: Database.Database | null = null;

function getDb(): Database.Database {
  if (db) return db;
  if (!existsSync(DB_PATH)) throw new Error(`Database not found: ${DB_PATH}`);
  db = new Database(DB_PATH, { readonly: false });
  db.pragma("journal_mode = WAL");
  db.pragma("busy_timeout = 5000");
  return db;
}

// ─── Token Management ───────────────────────────────────────────────

type LinkedInProvider = "linkedin" | "linkedin-community";

async function ensureFreshToken(provider: LinkedInProvider = "linkedin"): Promise<string> {
  const database = getDb();
  const row = database
    .prepare("SELECT access_token, refresh_token, expires_at, scopes, extra FROM oauth_tokens WHERE provider = ?")
    .get(provider) as any;

  if (!row) throw new Error(`No ${provider} tokens — run: npx tsx oauth-setup.ts ${provider}`);

  const expiresAt = new Date(row.expires_at).getTime();
  if (Date.now() < expiresAt - 5 * 60 * 1000) {
    return row.access_token;
  }

  if (!row.refresh_token || row.refresh_token === "none") {
    throw new Error(`${provider} token expired and no refresh token available — re-run: npx tsx oauth-setup.ts ${provider}`);
  }

  console.error(`[mcp-linkedin] Refreshing ${provider} token...`);
  const clientId = provider === "linkedin-community"
    ? process.env.LINKEDIN_COMMUNITY_CLIENT_ID
    : process.env.LINKEDIN_CLIENT_ID;
  const clientSecret = provider === "linkedin-community"
    ? process.env.LINKEDIN_COMMUNITY_CLIENT_SECRET
    : process.env.LINKEDIN_CLIENT_SECRET;
  if (!clientId || !clientSecret) throw new Error(`Client credentials required for ${provider}`);

  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: row.refresh_token,
    client_id: clientId,
    client_secret: clientSecret,
  });

  const res = await fetch("https://www.linkedin.com/oauth/v2/accessToken", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`${provider} token refresh failed (${res.status}): ${text}`);
  }

  const data = (await res.json()) as {
    access_token: string;
    refresh_token?: string;
    expires_in: number;
  };

  const newExpiresAt = new Date(Date.now() + data.expires_in * 1000).toISOString();
  database
    .prepare(
      `UPDATE oauth_tokens SET access_token = ?, refresh_token = COALESCE(?, refresh_token), expires_at = ?, updated_at = datetime('now') WHERE provider = ?`
    )
    .run(data.access_token, data.refresh_token || null, newExpiresAt, provider);

  return data.access_token;
}

function getPersonUrn(): string {
  const database = getDb();
  const row = database
    .prepare("SELECT extra FROM oauth_tokens WHERE provider = 'linkedin'")
    .get() as { extra: string | null } | undefined;

  if (!row?.extra) throw new Error("LinkedIn person URN not found — re-run oauth-setup.ts linkedin");
  const extra = JSON.parse(row.extra);
  if (!extra.personUrn) throw new Error("LinkedIn person URN not in extra — re-run oauth-setup.ts linkedin");
  return extra.personUrn;
}

// ─── Notification Helper ────────────────────────────────────────────

function writeNotification(summary: string): void {
  const entry = JSON.stringify({
    task: "linkedin-draft",
    channel: "linkedin",
    summary,
    timestamp: new Date().toISOString(),
  });
  appendFileSync(NOTIFY_FILE, entry + "\n");
}

// ─── Server Setup ───────────────────────────────────────────────────

const server = new McpServer({
  name: "mcp-linkedin",
  version: "1.0.0",
});

// Startup version check
const versionDate = new Date(
  parseInt(LINKEDIN_VERSION.slice(0, 4)),
  parseInt(LINKEDIN_VERSION.slice(4, 6)) - 1
);
const monthsOld = (Date.now() - versionDate.getTime()) / (30 * 24 * 60 * 60 * 1000);
if (monthsOld > 6) {
  console.error(`[mcp-linkedin] WARNING: LinkedIn-Version header "${LINKEDIN_VERSION}" is ${Math.round(monthsOld)} months old — update it.`);
}

// ─── Tool: linkedin_draft ───────────────────────────────────────────

server.tool(
  "linkedin_draft",
  "Store a LinkedIn post draft for approval. Does NOT call LLM — the calling agent generates the content. Creates approval token and notifies Discord #linkedin.",
  {
    topic: z.string().describe("What the post is about"),
    content: z.string().describe("Full post content (already written by LLM)"),
    signals: z.string().optional().describe("JSON array of signals that inspired this post"),
  },
  async ({ topic, content, signals }) => {
    const database = getDb();
    const id = `post-${Date.now().toString(36)}`;
    const approvalToken = randomBytes(16).toString("hex");

    database
      .prepare(
        `INSERT INTO linkedin_posts (id, status, topic, content, signals, approval_token)
         VALUES (?, 'pending_approval', ?, ?, ?, ?)`
      )
      .run(id, topic, content, signals || null, approvalToken);

    // Write notification for Discord bot to pick up
    const preview = content.length > 300 ? content.slice(0, 300) + "..." : content;
    writeNotification(
      `**New LinkedIn Post Draft**\n\n` +
      `**Topic:** ${topic}\n\n` +
      `${preview}\n\n` +
      `To approve: \`!approve ${approvalToken}\`\n` +
      `To reject: \`!reject ${approvalToken}\``
    );

    return {
      content: [{
        type: "text" as const,
        text: `Draft created: ${id}\nApproval token: ${approvalToken}\nStatus: pending_approval\nNotification sent to #linkedin`,
      }],
    };
  }
);

// ─── Tool: linkedin_post ────────────────────────────────────────────

server.tool(
  "linkedin_post",
  "Publish an approved LinkedIn post. Requires a valid single-use approval token.",
  {
    approvalToken: z.string().describe("The approval token from the draft"),
  },
  async ({ approvalToken }) => {
    const database = getDb();
    const post = database
      .prepare("SELECT * FROM linkedin_posts WHERE approval_token = ?")
      .get(approvalToken) as any;

    if (!post) {
      return { content: [{ type: "text" as const, text: "Invalid approval token — no matching draft found." }] };
    }

    if (post.status === "published") {
      return { content: [{ type: "text" as const, text: `Post ${post.id} was already published at ${post.published_at}.` }] };
    }

    if (post.status !== "approved" && post.status !== "pending_approval") {
      return { content: [{ type: "text" as const, text: `Post ${post.id} has status "${post.status}" — cannot publish.` }] };
    }

    const token = await ensureFreshToken();
    const personUrn = getPersonUrn();

    // LinkedIn REST Posts API
    const res = await fetch("https://api.linkedin.com/rest/posts", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        "LinkedIn-Version": LINKEDIN_VERSION,
        "X-Restli-Protocol-Version": "2.0.0",
      },
      body: JSON.stringify({
        author: personUrn,
        commentary: post.content,
        visibility: "PUBLIC",
        distribution: {
          feedDistribution: "MAIN_FEED",
          targetEntities: [],
          thirdPartyDistributionChannels: [],
        },
        lifecycleState: "PUBLISHED",
      }),
    });

    if (!res.ok) {
      const text = await res.text();
      return {
        content: [{
          type: "text" as const,
          text: `LinkedIn publish failed (${res.status}): ${text.slice(0, 500)}`,
        }],
      };
    }

    const linkedinPostId = res.headers.get("x-restli-id") || res.headers.get("x-linkedin-id") || "";
    database
      .prepare(
        "UPDATE linkedin_posts SET status = 'published', linkedin_post_id = ?, published_at = datetime('now'), approval_token = NULL WHERE id = ?"
      )
      .run(linkedinPostId, post.id);

    return {
      content: [{
        type: "text" as const,
        text: `Published! LinkedIn Post ID: ${linkedinPostId}\nDraft: ${post.id}`,
      }],
    };
  }
);

// ─── Tool: linkedin_history ─────────────────────────────────────────

server.tool(
  "linkedin_history",
  "View LinkedIn post history — drafts, approved, published, rejected.",
  {
    status: z.string().optional().describe("Filter by status: draft, pending_approval, approved, published, rejected"),
    limit: z.number().optional().default(10).describe("Max results"),
  },
  async ({ status, limit }) => {
    const database = getDb();
    let query = "SELECT id, status, topic, content, created_at, published_at FROM linkedin_posts";
    const params: any[] = [];

    if (status) {
      query += " WHERE status = ?";
      params.push(status);
    }

    query += " ORDER BY created_at DESC LIMIT ?";
    params.push(limit);

    const rows = database.prepare(query).all(...params) as any[];

    if (rows.length === 0) {
      return { content: [{ type: "text" as const, text: "No LinkedIn posts found." }] };
    }

    const formatted = rows.map((r: any) => {
      const preview = r.content.length > 150 ? r.content.slice(0, 150) + "..." : r.content;
      const published = r.published_at ? ` (published: ${r.published_at})` : "";
      return `[${r.id}] ${r.status} — ${r.topic}${published}\n  ${r.created_at}\n  ${preview}`;
    });

    return { content: [{ type: "text" as const, text: formatted.join("\n\n") }] };
  }
);

// ─── Tool: linkedin_comment ──────────────────────────────────────────

server.tool(
  "linkedin_comment",
  "Add a comment to a LinkedIn post. Requires Community Management API tokens (linkedin-community provider). Use this to continue a post as a comment thread.",
  {
    postUrn: z.string().describe("The post URN (e.g., urn:li:share:123456 or urn:li:ugcPost:123456)"),
    comment: z.string().describe("The comment text"),
  },
  async ({ postUrn, comment }) => {
    const token = await ensureFreshToken("linkedin-community");
    const personUrn = getPersonUrn();

    const res = await fetch("https://api.linkedin.com/rest/socialActions/" + encodeURIComponent(postUrn) + "/comments", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        "LinkedIn-Version": LINKEDIN_VERSION,
        "X-Restli-Protocol-Version": "2.0.0",
      },
      body: JSON.stringify({
        actor: personUrn,
        message: { text: comment },
      }),
    });

    if (!res.ok) {
      const text = await res.text();
      return {
        content: [{
          type: "text" as const,
          text: `Comment failed (${res.status}): ${text.slice(0, 500)}`,
        }],
      };
    }

    const commentId = res.headers.get("x-restli-id") || "";
    return {
      content: [{
        type: "text" as const,
        text: `Comment posted! ID: ${commentId}\nOn post: ${postUrn}`,
      }],
    };
  }
);

// ─── Tool: linkedin_delete ──────────────────────────────────────────

server.tool(
  "linkedin_delete",
  "Delete a LinkedIn post by its URN.",
  {
    postUrn: z.string().describe("The post URN to delete (e.g., urn:li:share:123456)"),
  },
  async ({ postUrn }) => {
    const token = await ensureFreshToken();

    const res = await fetch("https://api.linkedin.com/rest/posts/" + encodeURIComponent(postUrn), {
      method: "DELETE",
      headers: {
        Authorization: `Bearer ${token}`,
        "LinkedIn-Version": LINKEDIN_VERSION,
        "X-Restli-Protocol-Version": "2.0.0",
      },
    });

    if (!res.ok) {
      const text = await res.text();
      return {
        content: [{
          type: "text" as const,
          text: `Delete failed (${res.status}): ${text.slice(0, 500)}`,
        }],
      };
    }

    // Update local DB if we have this post tracked
    const database = getDb();
    database
      .prepare("UPDATE linkedin_posts SET status = 'rejected' WHERE linkedin_post_id = ?")
      .run(postUrn);

    return {
      content: [{
        type: "text" as const,
        text: `Post deleted: ${postUrn}`,
      }],
    };
  }
);

// ─── Tool: linkedin_profile ─────────────────────────────────────────

server.tool(
  "linkedin_profile",
  "Get the authenticated LinkedIn user's profile info.",
  {},
  async () => {
    const token = await ensureFreshToken();

    const res = await fetch("https://api.linkedin.com/v2/userinfo", {
      headers: { Authorization: `Bearer ${token}` },
    });

    if (!res.ok) {
      const text = await res.text();
      return { content: [{ type: "text" as const, text: `Profile fetch failed (${res.status}): ${text}` }] };
    }

    const data = (await res.json()) as {
      sub: string;
      name?: string;
      given_name?: string;
      family_name?: string;
      picture?: string;
    };

    const lines = [
      `Name: ${data.name || [data.given_name, data.family_name].filter(Boolean).join(" ")}`,
      `Person URN: urn:li:person:${data.sub}`,
    ].filter(Boolean);

    return { content: [{ type: "text" as const, text: lines.join("\n") }] };
  }
);

// ─── Start Server ───────────────────────────────────────────────────

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("[mcp-linkedin] Server started");
}

main().catch((err) => {
  console.error("[mcp-linkedin] Fatal:", err);
  process.exit(1);
});
