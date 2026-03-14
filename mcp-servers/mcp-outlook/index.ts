#!/usr/bin/env node
/**
 * MCP Outlook Server
 *
 * Exposes Microsoft Outlook (Graph API) as MCP tools: email search, full email
 * read, calendar view, watched sender management, and structured digests.
 *
 * Token management is deterministic — auto-refresh via oauth_tokens table.
 * Only the LLM's interpretation of results is non-deterministic.
 *
 * IMPORTANT: Never use console.log — it corrupts the JSON-RPC stream.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import Database from "better-sqlite3";
import { existsSync, readFileSync } from "fs";
import { join } from "path";
import { createCipheriv, createDecipheriv, randomBytes } from "crypto";

// ─── Configuration ───────────────────────────────────────────────────

const HARNESS_ROOT = process.env.HARNESS_ROOT || ".";
const DB_PATH = join(HARNESS_ROOT, "bridges", "discord", "harness.db");
const GRAPH_BASE = "https://graph.microsoft.com/v1.0";

// ─── Database ────────────────────────────────────────────────────────

let db: Database.Database | null = null;

function getDb(): Database.Database {
  if (db) return db;
  if (!existsSync(DB_PATH)) {
    throw new Error(`Database not found: ${DB_PATH}`);
  }
  db = new Database(DB_PATH, { readonly: false });
  db.pragma("journal_mode = WAL");
  db.pragma("busy_timeout = 5000");
  return db;
}

// ─── Encryption (matches oauth-store.ts format) ────────────────────

const ENCRYPTION_KEY = process.env.OAUTH_ENCRYPTION_KEY || "";

function decryptToken(ciphertext: string): string {
  if (!ENCRYPTION_KEY || ENCRYPTION_KEY.length !== 64) return ciphertext;
  const parts = ciphertext.split(":");
  if (parts.length !== 3) return ciphertext; // Not encrypted (legacy/dev)
  const [ivHex, tagHex, dataHex] = parts;
  const key = Buffer.from(ENCRYPTION_KEY, "hex");
  const iv = Buffer.from(ivHex, "hex");
  const tag = Buffer.from(tagHex, "hex");
  const data = Buffer.from(dataHex, "hex");
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(data), decipher.final()]).toString("utf8");
}

function encryptToken(plaintext: string): string {
  if (!ENCRYPTION_KEY || ENCRYPTION_KEY.length !== 64) return plaintext;
  const key = Buffer.from(ENCRYPTION_KEY, "hex");
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${iv.toString("hex")}:${tag.toString("hex")}:${encrypted.toString("hex")}`;
}

// ─── Token Management ───────────────────────────────────────────────

interface TokenRow {
  access_token: string;
  refresh_token: string;
  expires_at: string;
  scopes: string;
}

async function ensureFreshToken(): Promise<string> {
  const database = getDb();
  const row = database
    .prepare("SELECT access_token, refresh_token, expires_at, scopes FROM oauth_tokens WHERE provider = 'microsoft'")
    .get() as TokenRow | undefined;

  if (!row) throw new Error("No Microsoft tokens — run: npx tsx oauth-setup.ts microsoft");

  // Check expiry with 5-minute buffer
  const expiresAt = new Date(row.expires_at).getTime();
  if (Date.now() < expiresAt - 5 * 60 * 1000) {
    return row.access_token;
  }

  // Refresh token
  console.error("[mcp-outlook] Refreshing Microsoft token...");
  const clientId = process.env.MS_CLIENT_ID;
  const clientSecret = process.env.MS_CLIENT_SECRET;
  if (!clientId || !clientSecret) throw new Error("MS_CLIENT_ID and MS_CLIENT_SECRET required");

  const body = new URLSearchParams({
    client_id: clientId,
    client_secret: clientSecret,
    refresh_token: decryptToken(row.refresh_token),
    grant_type: "refresh_token",
    scope: row.scopes,
  });

  const res = await fetch("https://login.microsoftonline.com/consumers/oauth2/v2.0/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Microsoft token refresh failed (${res.status}): ${text}`);
  }

  const data = (await res.json()) as {
    access_token: string;
    refresh_token?: string;
    expires_in: number;
    scope: string;
  };

  const newExpiresAt = new Date(Date.now() + data.expires_in * 1000).toISOString();
  database
    .prepare(
      `UPDATE oauth_tokens SET access_token = ?, refresh_token = COALESCE(?, refresh_token), expires_at = ?, updated_at = datetime('now') WHERE provider = 'microsoft'`
    )
    .run(data.access_token, data.refresh_token ? encryptToken(data.refresh_token) : null, newExpiresAt);

  return data.access_token;
}

async function graphFetch(path: string, params?: Record<string, string>, headers?: Record<string, string>): Promise<any> {
  const token = await ensureFreshToken();
  const url = new URL(`${GRAPH_BASE}${path}`);
  if (params) {
    for (const [k, v] of Object.entries(params)) {
      url.searchParams.set(k, v);
    }
  }

  const res = await fetch(url.toString(), {
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      ...headers,
    },
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Graph API ${path} failed (${res.status}): ${text.slice(0, 500)}`);
  }

  return res.json();
}

// ─── Helpers ────────────────────────────────────────────────────────

function matchProject(subject: string, senderEmail: string): string | null {
  const database = getDb();
  // Check watched senders first
  const sender = database
    .prepare("SELECT project FROM watched_senders WHERE email = ?")
    .get(senderEmail) as { project: string | null } | undefined;
  if (sender?.project) return sender.project;

  // Check project names against subject
  try {
    const projectsPath = join(HARNESS_ROOT, "heartbeat-tasks", "projects.json");
    if (existsSync(projectsPath)) {
      const projects = JSON.parse(readFileSync(projectsPath, "utf-8")) as Array<{ name: string; keywords?: string[] }>;
      const subjectLower = subject.toLowerCase();
      for (const p of projects) {
        if (subjectLower.includes(p.name.toLowerCase())) return p.name;
        if (p.keywords) {
          for (const kw of p.keywords) {
            if (subjectLower.includes(kw.toLowerCase())) return p.name;
          }
        }
      }
    }
  } catch {
    // Project matching is best-effort
  }

  return null;
}

// ─── Server Setup ───────────────────────────────────────────────────

const server = new McpServer({
  name: "mcp-outlook",
  version: "1.0.0",
});

// ─── Tool: outlook_emails ───────────────────────────────────────────

server.tool(
  "outlook_emails",
  "Search indexed emails from the local cache or live from Outlook. Returns sender, subject, date, snippet, and matched project.",
  {
    query: z.string().optional().describe("Full-text search query"),
    sender: z.string().optional().describe("Filter by sender email"),
    project: z.string().optional().describe("Filter by matched project"),
    since: z.string().optional().describe("ISO date — only emails after this date"),
    until: z.string().optional().describe("ISO date — only emails before this date"),
    limit: z.number().optional().default(20).describe("Max results"),
    liveSearch: z.boolean().optional().default(false).describe("Also search Outlook via Graph API $search"),
  },
  async ({ query, sender, project, since, until, limit, liveSearch }) => {
    const database = getDb();
    const conditions: string[] = [];
    const params: any[] = [];

    if (query) {
      conditions.push("(subject LIKE ? OR snippet LIKE ? OR sender_name LIKE ?)");
      const like = `%${query}%`;
      params.push(like, like, like);
    }
    if (sender) {
      conditions.push("sender_email = ?");
      params.push(sender);
    }
    if (project) {
      conditions.push("matched_project = ?");
      params.push(project);
    }
    if (since) {
      conditions.push("received_at >= ?");
      params.push(since);
    }
    if (until) {
      conditions.push("received_at <= ?");
      params.push(until);
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
    const rows = database
      .prepare(`SELECT message_id, subject, sender_name, sender_email, received_at, snippet, matched_project, is_read FROM email_index ${where} ORDER BY received_at DESC LIMIT ?`)
      .all(...params, limit) as any[];

    // Live search supplement
    let liveResults: string[] = [];
    if (liveSearch && query) {
      try {
        const data = await graphFetch("/me/messages", {
          $search: `"${query}"`,
          $top: String(Math.min(limit, 10)),
          $select: "id,subject,from,receivedDateTime,bodyPreview,importance,isRead",
        });
        for (const msg of data.value || []) {
          const fromEmail = msg.from?.emailAddress?.address || "unknown";
          const fromName = msg.from?.emailAddress?.name || fromEmail;
          liveResults.push(
            `[LIVE] ${fromName} <${fromEmail}>\n  Subject: ${msg.subject}\n  Date: ${msg.receivedDateTime}\n  Preview: ${(msg.bodyPreview || "").slice(0, 200)}`
          );
        }
      } catch (err: any) {
        liveResults.push(`Live search failed: ${err.message}`);
      }
    }

    const formatted = rows.map((r: any) => {
      const project = r.matched_project ? ` [${r.matched_project}]` : "";
      const read = r.is_read ? "" : " (UNREAD)";
      return `${r.sender_name} <${r.sender_email}>${project}${read}\n  Subject: ${r.subject}\n  Date: ${r.received_at}\n  ${(r.snippet || "").slice(0, 200)}`;
    });

    const all = [...formatted, ...liveResults];
    if (all.length === 0) {
      return { content: [{ type: "text" as const, text: "No emails found matching your criteria." }] };
    }

    return {
      content: [{
        type: "text" as const,
        text: `${formatted.length} indexed${liveResults.length > 0 ? ` + ${liveResults.length} live` : ""} result(s):\n\n${all.join("\n\n")}`,
      }],
    };
  }
);

// ─── Tool: outlook_email_read ───────────────────────────────────────

server.tool(
  "outlook_email_read",
  "Read a full email by its message ID. Returns subject, from, to, cc, date, body text, and attachment names.",
  {
    messageId: z.string().describe("The Graph API message ID"),
  },
  async ({ messageId }) => {
    const data = await graphFetch(`/me/messages/${messageId}`, {
      $select: "id,subject,from,toRecipients,ccRecipients,receivedDateTime,body,hasAttachments,importance",
    }, {
      Prefer: 'outlook.body-content-type="text"',
    });

    const from = data.from?.emailAddress;
    const to = (data.toRecipients || []).map((r: any) => `${r.emailAddress?.name || ""} <${r.emailAddress?.address}>`).join(", ");
    const cc = (data.ccRecipients || []).map((r: any) => `${r.emailAddress?.name || ""} <${r.emailAddress?.address}>`).join(", ");

    let attachmentNames: string[] = [];
    if (data.hasAttachments) {
      try {
        const attData = await graphFetch(`/me/messages/${messageId}/attachments`, {
          $select: "name,contentType,size",
        });
        attachmentNames = (attData.value || []).map((a: any) => `${a.name} (${a.contentType}, ${Math.round(a.size / 1024)}KB)`);
      } catch {
        attachmentNames = ["(failed to fetch attachments)"];
      }
    }

    const lines = [
      `Subject: ${data.subject}`,
      `From: ${from?.name || ""} <${from?.address}>`,
      `To: ${to}`,
      cc ? `CC: ${cc}` : null,
      `Date: ${data.receivedDateTime}`,
      `Importance: ${data.importance}`,
      attachmentNames.length > 0 ? `Attachments: ${attachmentNames.join("; ")}` : null,
      "",
      data.body?.content || "(empty body)",
    ].filter(Boolean);

    return { content: [{ type: "text" as const, text: lines.join("\n") }] };
  }
);

// ─── Tool: outlook_calendar ─────────────────────────────────────────

server.tool(
  "outlook_calendar",
  "View calendar events from Outlook. Returns subject, start/end, location, organizer. Can tag school events.",
  {
    startDate: z.string().optional().describe("ISO date for range start (default: now)"),
    endDate: z.string().optional().describe("ISO date for range end (default: +7 days)"),
    includeSchool: z.boolean().optional().default(true).describe("Tag events matching school keywords"),
  },
  async ({ startDate, endDate, includeSchool }) => {
    const start = startDate || new Date().toISOString();
    const end = endDate || new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();

    const data = await graphFetch("/me/calendarview", {
      startdatetime: start,
      enddatetime: end,
      $select: "subject,start,end,location,organizer,isAllDay,isCancelled",
      $orderby: "start/dateTime",
      $top: "50",
    });

    const events = data.value || [];
    if (events.length === 0) {
      return { content: [{ type: "text" as const, text: "No calendar events found in the specified range." }] };
    }

    // School keywords for tagging
    const schoolKeywords = ["class", "lecture", "lab", "exam", "quiz", "office hours", "assignment", "homework", "midterm", "final", "professor", "ta ", "recitation", "tutorial"];

    const formatted = events.map((e: any) => {
      const startTime = e.start?.dateTime || "";
      const endTime = e.end?.dateTime || "";
      const location = e.location?.displayName ? ` @ ${e.location.displayName}` : "";
      const organizer = e.organizer?.emailAddress?.name || "";
      const cancelled = e.isCancelled ? " [CANCELLED]" : "";

      let schoolTag = "";
      if (includeSchool) {
        const subjectLower = (e.subject || "").toLowerCase();
        const isSchool = schoolKeywords.some((kw) => subjectLower.includes(kw)) ||
          (organizer && isSchoolOrganizer(organizer));
        if (isSchool) schoolTag = " [SCHOOL]";
      }

      return `${e.subject}${schoolTag}${cancelled}\n  ${startTime} → ${endTime}${location}\n  Organizer: ${organizer}`;
    });

    return {
      content: [{
        type: "text" as const,
        text: `${events.length} event(s):\n\n${formatted.join("\n\n")}`,
      }],
    };
  }
);

function isSchoolOrganizer(name: string): boolean {
  // Check watched senders with label 'professor'
  try {
    const database = getDb();
    const count = database
      .prepare("SELECT COUNT(*) as c FROM watched_senders WHERE label = 'professor' AND (email LIKE ? OR ? LIKE '%' || email || '%')")
      .get(`%${name}%`, name) as { c: number };
    return count.c > 0;
  } catch {
    return false;
  }
}

// ─── Tool: outlook_senders ──────────────────────────────────────────

server.tool(
  "outlook_senders",
  "Manage watched senders — get alerts in Discord when they email you.",
  {
    action: z.enum(["list", "add", "remove"]).describe("Action to perform"),
    email: z.string().optional().describe("Sender email (required for add/remove)"),
    label: z.string().optional().describe("Label: professor, recruiter, collaborator, etc. (required for add)"),
    project: z.string().optional().describe("Associate with a project (optional for add)"),
  },
  async ({ action, email, label, project }) => {
    const database = getDb();

    if (action === "list") {
      const rows = database.prepare("SELECT * FROM watched_senders ORDER BY label, email").all() as any[];
      if (rows.length === 0) {
        return { content: [{ type: "text" as const, text: "No watched senders configured. Use action:'add' to add one." }] };
      }
      const formatted = rows.map((r: any) => {
        const proj = r.project ? ` [${r.project}]` : "";
        return `- ${r.email} (${r.label})${proj} → #${r.discord_channel}`;
      });
      return { content: [{ type: "text" as const, text: `Watched senders:\n${formatted.join("\n")}` }] };
    }

    if (action === "add") {
      if (!email) return { content: [{ type: "text" as const, text: "Error: email is required for add." }] };
      if (!label) return { content: [{ type: "text" as const, text: "Error: label is required for add." }] };

      database
        .prepare(
          "INSERT INTO watched_senders (email, label, project) VALUES (?, ?, ?) ON CONFLICT(email) DO UPDATE SET label = excluded.label, project = excluded.project"
        )
        .run(email.toLowerCase(), label, project || null);

      return { content: [{ type: "text" as const, text: `Added watched sender: ${email} (${label})${project ? ` → ${project}` : ""}` }] };
    }

    if (action === "remove") {
      if (!email) return { content: [{ type: "text" as const, text: "Error: email is required for remove." }] };
      const result = database.prepare("DELETE FROM watched_senders WHERE email = ?").run(email.toLowerCase());
      if (result.changes === 0) {
        return { content: [{ type: "text" as const, text: `Sender ${email} was not in the watch list.` }] };
      }
      return { content: [{ type: "text" as const, text: `Removed watched sender: ${email}` }] };
    }

    return { content: [{ type: "text" as const, text: "Unknown action." }] };
  }
);

// ─── Tool: outlook_summary ──────────────────────────────────────────

server.tool(
  "outlook_summary",
  "Structured email + calendar digest for context injection. Groups emails by sender, counts unread, lists watched sender alerts, and shows upcoming events.",
  {
    days: z.number().optional().default(1).describe("Look back N days for emails"),
    focusProject: z.string().optional().describe("Highlight emails matching this project"),
  },
  async ({ days, focusProject }) => {
    const database = getDb();
    const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();

    // Email summary
    const emails = database
      .prepare(
        `SELECT sender_name, sender_email, COUNT(*) as count, SUM(CASE WHEN is_read = 0 THEN 1 ELSE 0 END) as unread
         FROM email_index WHERE received_at >= ? GROUP BY sender_email ORDER BY count DESC LIMIT 15`
      )
      .all(since) as any[];

    const totalUnread = database
      .prepare("SELECT COUNT(*) as c FROM email_index WHERE received_at >= ? AND is_read = 0")
      .get(since) as { c: number };

    // Watched sender alerts
    const watchedAlerts = database
      .prepare(
        `SELECT e.sender_name, e.sender_email, e.subject, e.received_at, w.label
         FROM email_index e JOIN watched_senders w ON e.sender_email = w.email
         WHERE e.received_at >= ? ORDER BY e.received_at DESC LIMIT 10`
      )
      .all(since) as any[];

    // Project-focused emails
    let projectEmails: any[] = [];
    if (focusProject) {
      projectEmails = database
        .prepare(
          "SELECT subject, sender_name, received_at FROM email_index WHERE matched_project = ? AND received_at >= ? ORDER BY received_at DESC LIMIT 5"
        )
        .all(focusProject, since) as any[];
    }

    // Calendar (next 12 hours)
    let calendarEvents: string[] = [];
    try {
      const now = new Date().toISOString();
      const later = new Date(Date.now() + 12 * 60 * 60 * 1000).toISOString();
      const calData = await graphFetch("/me/calendarview", {
        startdatetime: now,
        enddatetime: later,
        $select: "subject,start,end,location",
        $orderby: "start/dateTime",
        $top: "10",
      });
      calendarEvents = (calData.value || []).map((e: any) => {
        const loc = e.location?.displayName ? ` @ ${e.location.displayName}` : "";
        return `- ${e.subject} (${e.start?.dateTime?.slice(11, 16)} → ${e.end?.dateTime?.slice(11, 16)})${loc}`;
      });
    } catch (err: any) {
      calendarEvents = [`(Calendar unavailable: ${err.message})`];
    }

    // Build summary
    const sections: string[] = [];

    sections.push(`## Email Summary (last ${days}d)`);
    sections.push(`Total unread: ${totalUnread.c}`);
    if (emails.length > 0) {
      sections.push("By sender:");
      for (const e of emails) {
        const unreadNote = e.unread > 0 ? ` (${e.unread} unread)` : "";
        sections.push(`  - ${e.sender_name}: ${e.count} email(s)${unreadNote}`);
      }
    }

    if (watchedAlerts.length > 0) {
      sections.push("\n## Watched Sender Alerts");
      for (const a of watchedAlerts) {
        sections.push(`- [${a.label}] ${a.sender_name}: "${a.subject}" (${a.received_at})`);
      }
    }

    if (projectEmails.length > 0) {
      sections.push(`\n## Project: ${focusProject}`);
      for (const e of projectEmails) {
        sections.push(`- ${e.sender_name}: "${e.subject}" (${e.received_at})`);
      }
    }

    if (calendarEvents.length > 0) {
      sections.push("\n## Upcoming (next 12h)");
      sections.push(...calendarEvents);
    }

    return { content: [{ type: "text" as const, text: sections.join("\n") }] };
  }
);

// ─── Start Server ───────────────────────────────────────────────────

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("[mcp-outlook] Server started");
}

main().catch((err) => {
  console.error("[mcp-outlook] Fatal:", err);
  process.exit(1);
});
