#!/usr/bin/env node
/**
 * MCP Calendar Server
 *
 * CRUD operations on calendar events via a backend abstraction layer.
 * Phase 1: AppleScript backend (macOS Calendar.app, iCloud-synced to iPhone).
 * Future: Google Calendar API, Outlook Graph API backends.
 *
 * IMPORTANT: Never use console.log — it corrupts the JSON-RPC stream.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { execSync } from "child_process";
import ical from "node-ical";

// ─── Types ──────────────────────────────────────────────────────────

interface CalendarInfo {
  name: string;
}

interface CalendarEvent {
  uid: string;
  summary: string;
  startDate: string; // ISO 8601
  endDate: string;
  location: string;
  description: string;
  allDay: boolean;
  calendar: string;
}

interface CalendarBackend {
  listCalendars(): Promise<CalendarInfo[]>;
  getEvents(
    startDate: string,
    endDate: string,
    calendar?: string,
    limit?: number,
  ): Promise<CalendarEvent[]>;
  createEvent(params: {
    calendar: string;
    summary: string;
    startDate: string;
    endDate: string;
    location?: string;
    description?: string;
    allDay?: boolean;
  }): Promise<{ uid: string }>;
  updateEvent(
    uid: string,
    calendar: string,
    updates: Partial<{
      summary: string;
      startDate: string;
      endDate: string;
      location: string;
      description: string;
    }>,
  ): Promise<boolean>;
  deleteEvent(uid: string, calendar: string): Promise<boolean>;
  searchEvents(
    query: string,
    startDate: string,
    endDate: string,
    calendar?: string,
  ): Promise<CalendarEvent[]>;
}

// ─── AppleScript Helpers ────────────────────────────────────────────

function runAppleScript(script: string): string {
  try {
    return execSync(`osascript -e '${script.replace(/'/g, "'\\''")}'`, {
      encoding: "utf-8",
      timeout: 30000,
      stdio: ["pipe", "pipe", "pipe"],
    }).trim();
  } catch (err: any) {
    const msg = err.stderr?.trim() || err.message;
    throw new Error(`AppleScript error: ${msg}`);
  }
}

function runAppleScriptMultiline(lines: string[]): string {
  const script = lines.join("\n");
  try {
    const result = execSync("osascript", {
      input: script,
      encoding: "utf-8",
      timeout: 30000,
      stdio: ["pipe", "pipe", "pipe"],
    }).trim();
    return result;
  } catch (err: any) {
    const msg = err.stderr?.trim() || err.message;
    throw new Error(`AppleScript error: ${msg}`);
  }
}

/**
 * Convert ISO 8601 date string to AppleScript date-setting code.
 * Locale-independent: sets components individually on `current date`.
 */
function isoToAppleScriptDate(iso: string, varName: string): string[] {
  const d = new Date(iso);
  return [
    `set ${varName} to current date`,
    `set year of ${varName} to ${d.getFullYear()}`,
    `set month of ${varName} to ${d.getMonth() + 1}`,
    `set day of ${varName} to ${d.getDate()}`,
    `set hours of ${varName} to ${d.getHours()}`,
    `set minutes of ${varName} to ${d.getMinutes()}`,
    `set seconds of ${varName} to ${d.getSeconds()}`,
  ];
}

/**
 * Convert AppleScript date string to ISO 8601.
 * AppleScript dates look like: "Wednesday, March 19, 2026 at 3:00:00 PM"
 */
function appleScriptDateToISO(dateStr: string): string {
  try {
    const d = new Date(dateStr.replace(" at ", " "));
    if (isNaN(d.getTime())) return dateStr;
    return d.toISOString();
  } catch {
    return dateStr;
  }
}

function escapeAS(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

// ─── AppleScript Backend ────────────────────────────────────────────

class AppleScriptBackend implements CalendarBackend {
  async listCalendars(): Promise<CalendarInfo[]> {
    const result = runAppleScriptMultiline([
      'tell application "Calendar"',
      "  set output to {}",
      "  repeat with cal in calendars",
      "    set end of output to name of cal",
      "  end repeat",
      '  set AppleScript\'s text item delimiters to "\\n"',
      "  return output as text",
      "end tell",
    ]);
    if (!result) return [];
    return result.split("\n").filter(Boolean).map((name) => ({ name: name.trim() }));
  }

  async getEvents(
    startDate: string,
    endDate: string,
    calendar?: string,
    limit?: number,
  ): Promise<CalendarEvent[]> {
    const maxEvents = Math.min(limit || 50, 200);

    // Iterate calendars at top level, then query events per calendar.
    // Using `name of cal` avoids the broken `calendar of evt` reference.
    // Use tab as record delimiter and strip newlines from text fields
    // to avoid multi-line descriptions breaking the output parsing.
    const DELIM = "%%REC%%";
    const script = [
      // Helper to replace newlines/returns with spaces
      "on cleanText(txt)",
      "  set oldTID to AppleScript's text item delimiters",
      '  set AppleScript\'s text item delimiters to return',
      "  set parts to text items of txt",
      '  set AppleScript\'s text item delimiters to " "',
      "  set txt to parts as text",
      '  set AppleScript\'s text item delimiters to "\\n"',
      "  set parts to text items of txt",
      '  set AppleScript\'s text item delimiters to " "',
      "  set txt to parts as text",
      "  set AppleScript's text item delimiters to oldTID",
      "  return txt",
      "end cleanText",
      "",
      ...isoToAppleScriptDate(startDate, "startD"),
      ...isoToAppleScriptDate(endDate, "endD"),
      'tell application "Calendar"',
      "  set output to {}",
      "  set eventCount to 0",
      ...(calendar
        ? [`  set calList to {calendar "${escapeAS(calendar)}"}`]
        : ["  set calList to calendars"]),
      "  repeat with cal in calList",
      "    set calName to name of cal as text",
      "    tell cal",
      "      set evts to (every event whose start date ≥ startD and start date < endD)",
      "      repeat with evt in evts",
      `        if eventCount ≥ ${maxEvents} then exit repeat`,
      "        try",
      "          set evtUID to uid of evt as text",
      "          set evtSummary to summary of evt as text",
      "          set evtStart to start date of evt as text",
      "          set evtEnd to end date of evt as text",
      '          set evtLoc to ""',
      "          try",
      "            set rawLoc to location of evt",
      "            if rawLoc is not missing value then set evtLoc to my cleanText(rawLoc as text)",
      "          end try",
      '          set evtDesc to ""',
      "          try",
      "            set rawDesc to description of evt",
      "            if rawDesc is not missing value then set evtDesc to my cleanText(rawDesc as text)",
      "          end try",
      "          set evtAllDay to allday event of evt as text",
      `          set end of output to (evtUID & "||" & evtSummary & "||" & evtStart & "||" & evtEnd & "||" & evtLoc & "||" & evtDesc & "||" & evtAllDay & "||" & calName)`,
      "          set eventCount to eventCount + 1",
      "        end try",
      "      end repeat",
      "    end tell",
      `    if eventCount ≥ ${maxEvents} then exit repeat`,
      "  end repeat",
      `  set AppleScript's text item delimiters to "${DELIM}"`,
      "  return output as text",
      "end tell",
    ];

    const result = runAppleScriptMultiline(script);
    if (!result) return [];

    return result
      .split(DELIM)
      .filter(Boolean)
      .map((line) => {
        const parts = line.split("||");
        return {
          uid: parts[0] || "",
          summary: parts[1] || "",
          startDate: appleScriptDateToISO(parts[2] || ""),
          endDate: appleScriptDateToISO(parts[3] || ""),
          location: parts[4] || "",
          description: parts[5] || "",
          allDay: parts[6] === "true",
          calendar: parts[7] || "",
        };
      });
  }

  async createEvent(params: {
    calendar: string;
    summary: string;
    startDate: string;
    endDate: string;
    location?: string;
    description?: string;
    allDay?: boolean;
  }): Promise<{ uid: string }> {
    const props: string[] = [
      `summary:"${escapeAS(params.summary)}"`,
    ];
    if (params.location) props.push(`location:"${escapeAS(params.location)}"`);
    if (params.description) props.push(`description:"${escapeAS(params.description)}"`);
    if (params.allDay) props.push("allday event:true");

    const script = [
      ...isoToAppleScriptDate(params.startDate, "startD"),
      ...isoToAppleScriptDate(params.endDate, "endD"),
      'tell application "Calendar"',
      `  set targetCal to calendar "${escapeAS(params.calendar)}"`,
      `  set newEvent to make new event at end of events of targetCal with properties {${props.join(", ")}, start date:startD, end date:endD}`,
      "  return uid of newEvent",
      "end tell",
    ];

    const uid = runAppleScriptMultiline(script);
    return { uid };
  }

  async updateEvent(
    uid: string,
    calendar: string,
    updates: Partial<{
      summary: string;
      startDate: string;
      endDate: string;
      location: string;
      description: string;
    }>,
  ): Promise<boolean> {
    const setLines: string[] = [];
    if (updates.summary !== undefined)
      setLines.push(`      set summary of targetEvent to "${escapeAS(updates.summary)}"`);
    if (updates.location !== undefined)
      setLines.push(`      set location of targetEvent to "${escapeAS(updates.location)}"`);
    if (updates.description !== undefined)
      setLines.push(`      set description of targetEvent to "${escapeAS(updates.description)}"`);

    const dateLines: string[] = [];
    if (updates.startDate) {
      dateLines.push(...isoToAppleScriptDate(updates.startDate, "newStart"));
      setLines.push("      set start date of targetEvent to newStart");
    }
    if (updates.endDate) {
      dateLines.push(...isoToAppleScriptDate(updates.endDate, "newEnd"));
      setLines.push("      set end date of targetEvent to newEnd");
    }

    if (setLines.length === 0) return false;

    const script = [
      ...dateLines,
      'tell application "Calendar"',
      `  set targetCal to calendar "${escapeAS(calendar)}"`,
      "  set allEvents to every event of targetCal",
      "  repeat with evt in allEvents",
      `    if uid of evt is "${escapeAS(uid)}" then`,
      "      set targetEvent to evt",
      ...setLines,
      '      return "ok"',
      "    end if",
      "  end repeat",
      '  return "not_found"',
      "end tell",
    ];

    const result = runAppleScriptMultiline(script);
    return result === "ok";
  }

  async deleteEvent(uid: string, calendar: string): Promise<boolean> {
    const script = [
      'tell application "Calendar"',
      `  set targetCal to calendar "${escapeAS(calendar)}"`,
      "  set allEvents to every event of targetCal",
      "  repeat with evt in allEvents",
      `    if uid of evt is "${escapeAS(uid)}" then`,
      "      delete evt",
      '      return "ok"',
      "    end if",
      "  end repeat",
      '  return "not_found"',
      "end tell",
    ];

    const result = runAppleScriptMultiline(script);
    return result === "ok";
  }

  async searchEvents(
    query: string,
    startDate: string,
    endDate: string,
    calendar?: string,
  ): Promise<CalendarEvent[]> {
    // Get all events in range, filter by query in TypeScript (AppleScript text search is unreliable)
    const events = await this.getEvents(startDate, endDate, calendar, 200);
    const q = query.toLowerCase();
    return events.filter(
      (e) =>
        e.summary.toLowerCase().includes(q) ||
        e.location.toLowerCase().includes(q) ||
        e.description.toLowerCase().includes(q),
    );
  }
}

// ─── Backend Selection ──────────────────────────────────────────────

function getBackend(): CalendarBackend {
  const backend = process.env.CALENDAR_BACKEND || "applescript";
  switch (backend) {
    case "applescript":
      return new AppleScriptBackend();
    case "google":
      throw new Error("Google Calendar backend not yet implemented (Phase 4)");
    case "outlook":
      throw new Error("Outlook Calendar backend not yet implemented (Phase 5)");
    default:
      throw new Error(`Unknown calendar backend: ${backend}`);
  }
}

const backend = getBackend();

// ─── Helpers ────────────────────────────────────────────────────────

function defaultStartDate(): string {
  return new Date().toISOString();
}

function defaultEndDate(days: number = 7): string {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return d.toISOString();
}

function formatEvents(events: CalendarEvent[]): string {
  if (events.length === 0) return "No events found.";
  return events
    .map((e) => {
      const start = new Date(e.startDate);
      const end = new Date(e.endDate);
      const dateStr = e.allDay
        ? start.toLocaleDateString()
        : `${start.toLocaleString()} — ${end.toLocaleTimeString()}`;
      let line = `**${e.summary}**\n  ${dateStr}`;
      if (e.location) line += `\n  Location: ${e.location}`;
      if (e.calendar) line += `\n  Calendar: ${e.calendar}`;
      line += `\n  UID: ${e.uid}`;
      return line;
    })
    .join("\n\n");
}

// ─── Server Setup ───────────────────────────────────────────────────

const server = new McpServer({
  name: "mcp-calendar",
  version: "1.0.0",
});

// ─── Tool: calendar_list ────────────────────────────────────────────

server.tool(
  "calendar_list",
  "List all calendars available on this device.",
  {},
  async () => {
    const calendars = await backend.listCalendars();
    const text = calendars.length === 0
      ? "No calendars found."
      : calendars.map((c) => `- ${c.name}`).join("\n");
    return { content: [{ type: "text" as const, text }] };
  },
);

// ─── Tool: calendar_events ──────────────────────────────────────────

server.tool(
  "calendar_events",
  "Get calendar events within a date range. Defaults to the next 7 days.",
  {
    calendar: z.string().optional().describe("Calendar name to filter (omit for all calendars)"),
    startDate: z.string().optional().describe("Start date (ISO 8601). Default: now"),
    endDate: z.string().optional().describe("End date (ISO 8601). Default: +7 days"),
    limit: z.number().optional().default(50).describe("Max events to return (max 200)"),
  },
  async ({ calendar, startDate, endDate, limit }) => {
    const events = await backend.getEvents(
      startDate || defaultStartDate(),
      endDate || defaultEndDate(),
      calendar,
      limit,
    );
    return { content: [{ type: "text" as const, text: formatEvents(events) }] };
  },
);

// ─── Tool: calendar_create ──────────────────────────────────────────

server.tool(
  "calendar_create",
  "Create a new calendar event. Returns the event UID. Events sync to iPhone via iCloud.",
  {
    calendar: z.string().describe("Calendar name to create event in"),
    summary: z.string().describe("Event title"),
    startDate: z.string().describe("Start date/time (ISO 8601)"),
    endDate: z.string().describe("End date/time (ISO 8601)"),
    location: z.string().optional().describe("Event location"),
    description: z.string().optional().describe("Event description/notes"),
    allDay: z.boolean().optional().default(false).describe("All-day event"),
  },
  async ({ calendar, summary, startDate, endDate, location, description, allDay }) => {
    const result = await backend.createEvent({
      calendar,
      summary,
      startDate,
      endDate,
      location,
      description,
      allDay,
    });
    return {
      content: [
        {
          type: "text" as const,
          text: `Event created: "${summary}"\nUID: ${result.uid}\nCalendar: ${calendar}\nTime: ${new Date(startDate).toLocaleString()} — ${new Date(endDate).toLocaleString()}`,
        },
      ],
    };
  },
);

// ─── Tool: calendar_update ──────────────────────────────────────────

server.tool(
  "calendar_update",
  "Update an existing calendar event by UID. Only provided fields are changed.",
  {
    uid: z.string().describe("Event UID (from calendar_events or calendar_search)"),
    calendar: z.string().describe("Calendar name the event belongs to"),
    summary: z.string().optional().describe("New event title"),
    startDate: z.string().optional().describe("New start date/time (ISO 8601)"),
    endDate: z.string().optional().describe("New end date/time (ISO 8601)"),
    location: z.string().optional().describe("New location"),
    description: z.string().optional().describe("New description"),
  },
  async ({ uid, calendar, summary, startDate, endDate, location, description }) => {
    const updates: Record<string, string> = {};
    if (summary !== undefined) updates.summary = summary;
    if (startDate !== undefined) updates.startDate = startDate;
    if (endDate !== undefined) updates.endDate = endDate;
    if (location !== undefined) updates.location = location;
    if (description !== undefined) updates.description = description;

    const success = await backend.updateEvent(uid, calendar, updates);
    return {
      content: [
        {
          type: "text" as const,
          text: success
            ? `Event updated (UID: ${uid})`
            : `Event not found (UID: ${uid} in calendar "${calendar}")`,
        },
      ],
    };
  },
);

// ─── Tool: calendar_delete ──────────────────────────────────────────

server.tool(
  "calendar_delete",
  "Delete a calendar event by UID. Requires confirm=true as a safety gate.",
  {
    uid: z.string().describe("Event UID to delete"),
    calendar: z.string().describe("Calendar name the event belongs to"),
    confirm: z.boolean().describe("Must be true to confirm deletion"),
  },
  async ({ uid, calendar, confirm }) => {
    if (!confirm) {
      return {
        content: [
          { type: "text" as const, text: "Deletion cancelled — confirm must be true." },
        ],
      };
    }
    const success = await backend.deleteEvent(uid, calendar);
    return {
      content: [
        {
          type: "text" as const,
          text: success
            ? `Event deleted (UID: ${uid})`
            : `Event not found (UID: ${uid} in calendar "${calendar}")`,
        },
      ],
    };
  },
);

// ─── Tool: calendar_search ──────────────────────────────────────────

server.tool(
  "calendar_search",
  "Search for events by keyword in title, location, or description.",
  {
    query: z.string().describe("Search term"),
    startDate: z.string().optional().describe("Search window start (ISO 8601). Default: -7 days"),
    endDate: z.string().optional().describe("Search window end (ISO 8601). Default: +14 days"),
    calendar: z.string().optional().describe("Calendar name to filter"),
  },
  async ({ query, startDate, endDate, calendar }) => {
    const start = startDate || (() => {
      const d = new Date();
      d.setDate(d.getDate() - 7);
      return d.toISOString();
    })();
    const end = endDate || defaultEndDate(14);
    const events = await backend.searchEvents(query, start, end, calendar);
    return {
      content: [
        {
          type: "text" as const,
          text: events.length === 0
            ? `No events matching "${query}".`
            : `Found ${events.length} event(s):\n\n${formatEvents(events)}`,
        },
      ],
    };
  },
);

// ─── Tool: calendar_suggest_blocks ───────────────────────────────────

server.tool(
  "calendar_suggest_blocks",
  "Find free time blocks in a day by analyzing calendar events. Useful for scheduling study sessions or meetings.",
  {
    date: z.string().optional().describe("Date to analyze (ISO 8601 or YYYY-MM-DD). Default: today"),
    minGapMinutes: z.number().optional().default(60).describe("Minimum free block duration in minutes"),
    dayStartHour: z.number().optional().default(8).describe("Day start hour (0-23)"),
    dayEndHour: z.number().optional().default(22).describe("Day end hour (0-23)"),
    calendar: z.string().optional().describe("Calendar name to check (omit for all)"),
  },
  async ({ date, minGapMinutes, dayStartHour, dayEndHour, calendar }) => {
    const targetDate = date ? new Date(date) : new Date();
    const dayStart = new Date(targetDate);
    dayStart.setHours(dayStartHour, 0, 0, 0);
    const dayEnd = new Date(targetDate);
    dayEnd.setHours(dayEndHour, 0, 0, 0);

    const events = await backend.getEvents(
      dayStart.toISOString(),
      dayEnd.toISOString(),
      calendar,
      100,
    );

    // Sort events by start time
    const sorted = events
      .filter((e) => !e.allDay)
      .sort((a, b) => new Date(a.startDate).getTime() - new Date(b.startDate).getTime());

    // Find gaps
    const blocks: { start: Date; end: Date; minutes: number }[] = [];
    let cursor = dayStart;

    for (const evt of sorted) {
      const evtStart = new Date(evt.startDate);
      const evtEnd = new Date(evt.endDate);
      if (evtStart > cursor) {
        const gap = (evtStart.getTime() - cursor.getTime()) / 60000;
        if (gap >= minGapMinutes) {
          blocks.push({ start: new Date(cursor), end: evtStart, minutes: gap });
        }
      }
      if (evtEnd > cursor) cursor = evtEnd;
    }

    // Check gap after last event
    if (dayEnd > cursor) {
      const gap = (dayEnd.getTime() - cursor.getTime()) / 60000;
      if (gap >= minGapMinutes) {
        blocks.push({ start: new Date(cursor), end: dayEnd, minutes: gap });
      }
    }

    const dateStr = targetDate.toLocaleDateString("en-US", {
      weekday: "long",
      month: "long",
      day: "numeric",
    });
    const timeOpts: Intl.DateTimeFormatOptions = { hour: "numeric", minute: "2-digit" };

    if (blocks.length === 0) {
      return {
        content: [{
          type: "text" as const,
          text: `No free blocks of ${minGapMinutes}+ minutes on ${dateStr} (${dayStartHour}:00–${dayEndHour}:00).`,
        }],
      };
    }

    const text = `Free blocks on ${dateStr} (${minGapMinutes}+ min):\n\n` +
      blocks
        .map((b) =>
          `- ${b.start.toLocaleTimeString("en-US", timeOpts)} — ${b.end.toLocaleTimeString("en-US", timeOpts)} (${Math.round(b.minutes)} min)`)
        .join("\n");

    return { content: [{ type: "text" as const, text }] };
  },
);

// ─── Tool: calendar_import_ics ───────────────────────────────────────

server.tool(
  "calendar_import_ics",
  "Import events from a public iCal/ICS feed URL (Canvas, public calendars, etc). Read-only — does not write to Calendar.app.",
  {
    url: z.string().describe("ICS feed URL to fetch"),
    label: z.string().optional().describe("Label for this feed (e.g. 'Canvas')"),
    limit: z.number().optional().default(20).describe("Max events to return"),
    futureOnly: z.boolean().optional().default(true).describe("Only show future events"),
  },
  async ({ url, label, limit, futureOnly }) => {
    try {
      const data = await ical.async.fromURL(url);
      const now = new Date();
      const events: CalendarEvent[] = [];

      for (const [, comp] of Object.entries(data)) {
        if (!comp || comp.type !== "VEVENT") continue;
        const evt = comp as ical.VEvent;
        const start = evt.start ? new Date(evt.start as unknown as string) : null;
        if (!start) continue;
        if (futureOnly && start < now) continue;

        const summary = typeof evt.summary === "string"
          ? evt.summary
          : (evt.summary as any)?.val || "(no title)";
        const loc = typeof evt.location === "string"
          ? evt.location
          : (evt.location as any)?.val || "";
        const desc = typeof evt.description === "string"
          ? evt.description
          : (evt.description as any)?.val || "";

        events.push({
          uid: evt.uid || "",
          summary,
          startDate: start.toISOString(),
          endDate: evt.end ? new Date(evt.end as unknown as string).toISOString() : start.toISOString(),
          location: loc,
          description: desc,
          allDay: !evt.start || (evt.start as any).dateOnly === true,
          calendar: label || "ICS Import",
        });
      }

      // Sort by start date
      events.sort((a, b) => new Date(a.startDate).getTime() - new Date(b.startDate).getTime());
      const limited = events.slice(0, limit);

      const header = label ? `**${label}** feed` : "ICS feed";
      const text = limited.length === 0
        ? `${header}: No ${futureOnly ? "upcoming " : ""}events found.`
        : `${header}: ${limited.length} event(s)${events.length > limited.length ? ` (showing ${limited.length} of ${events.length})` : ""}\n\n${formatEvents(limited)}`;

      return { content: [{ type: "text" as const, text }] };
    } catch (err: any) {
      return {
        content: [{ type: "text" as const, text: `Failed to fetch ICS feed: ${err.message}` }],
        isError: true,
      };
    }
  },
);

// ─── Start ──────────────────────────────────────────────────────────

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("[mcp-calendar] Server started (backend: applescript)");
}

main().catch((err) => {
  console.error("[mcp-calendar] Fatal:", err);
  process.exit(1);
});
