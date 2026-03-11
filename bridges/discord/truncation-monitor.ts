/**
 * Truncation Monitor
 *
 * Wraps all truncation operations with observability. Logs when significant
 * content is lost, tracks patterns, and writes alerts to vault when
 * truncation exceeds configurable thresholds.
 *
 * Usage:
 *   import { monitor } from "./truncation-monitor.js";
 *   const result = monitor.truncate(text, limit, "context-assembler:learnings");
 *
 * The monitor distinguishes between:
 *   - Benign truncation (trimming whitespace, cutting noise)
 *   - Significant truncation (>20% of meaningful content lost)
 *   - Critical truncation (>50% lost, or structured data cut mid-block)
 */

import { appendFileSync, mkdirSync, existsSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";

const HARNESS_ROOT = process.env.HARNESS_ROOT || ".";
const LOG_DIR = join(HARNESS_ROOT, "context-log");
const TRUNCATION_LOG = join(LOG_DIR, "truncation-events.jsonl");
const ALERT_THRESHOLD_PERCENT = 30; // Alert when >30% of content is cut
const CRITICAL_THRESHOLD_PERCENT = 60; // Critical when >60% is cut
const STATS_FILE = join(LOG_DIR, "truncation-stats.json");

// Rolling window: keep last N events per source for pattern detection
const ROLLING_WINDOW = 50;

interface TruncationEvent {
  timestamp: number;
  source: string;
  originalLength: number;
  truncatedLength: number;
  percentLost: number;
  severity: "benign" | "significant" | "critical";
  structureDamaged: boolean;
  preview: string; // What was cut (first 200 chars of lost content)
}

interface TruncationStats {
  totalEvents: number;
  bySource: Record<string, {
    count: number;
    avgPercentLost: number;
    criticalCount: number;
    lastEvent: number;
  }>;
  lastUpdated: number;
}

// In-memory rolling window per source
const recentEvents = new Map<string, TruncationEvent[]>();

// ─── Core Truncation with Monitoring ────────────────────────────────

/**
 * Smart truncate that monitors and logs truncation events.
 * Prefers cutting at natural boundaries (paragraphs, sentences, lines).
 */
function truncate(text: string, maxChars: number, source: string): string {
  if (!text || text.length <= maxChars) return text;

  const original = text;
  let result: string;

  // Try to cut at a natural boundary instead of mid-word/sentence
  const cutZoneStart = Math.max(maxChars - 200, Math.floor(maxChars * 0.85));

  // Priority: paragraph break > heading > sentence end > line break > word boundary
  let cutPoint = maxChars;

  const paragraphBreak = original.lastIndexOf("\n\n", maxChars);
  if (paragraphBreak > cutZoneStart) {
    cutPoint = paragraphBreak;
  } else {
    const headingBreak = original.lastIndexOf("\n#", maxChars);
    if (headingBreak > cutZoneStart) {
      cutPoint = headingBreak;
    } else {
      const sentenceEnd = findLastSentenceEnd(original, cutZoneStart, maxChars);
      if (sentenceEnd > cutZoneStart) {
        cutPoint = sentenceEnd + 1;
      } else {
        const lineBreak = original.lastIndexOf("\n", maxChars);
        if (lineBreak > cutZoneStart) {
          cutPoint = lineBreak;
        } else {
          const wordBreak = original.lastIndexOf(" ", maxChars);
          if (wordBreak > cutZoneStart) {
            cutPoint = wordBreak;
          }
        }
      }
    }
  }

  result = original.slice(0, cutPoint).trimEnd();

  // Check if we cut inside a code block or YAML frontmatter
  const structureDamaged = checkStructureDamage(original, cutPoint);

  // If we damaged a code block, try to close it
  if (structureDamaged) {
    const openBlocks = (result.match(/```/g) || []).length;
    if (openBlocks % 2 !== 0) {
      result += "\n```\n*(truncated)*";
    }
  } else {
    result += "\n*(truncated)*";
  }

  // Log the event
  const percentLost = ((original.length - cutPoint) / original.length) * 100;
  const lostContent = original.slice(cutPoint);
  const severity = percentLost >= CRITICAL_THRESHOLD_PERCENT ? "critical"
    : percentLost >= ALERT_THRESHOLD_PERCENT ? "significant"
    : "benign";

  const event: TruncationEvent = {
    timestamp: Date.now(),
    source,
    originalLength: original.length,
    truncatedLength: cutPoint,
    percentLost: Math.round(percentLost * 10) / 10,
    severity,
    structureDamaged,
    preview: lostContent.slice(0, 200),
  };

  logEvent(event);

  return result;
}

/**
 * Truncate for Discord messages — splits into multiple chunks instead of cutting.
 * Returns an array of message strings, each within the Discord limit.
 */
function splitForDiscord(text: string, maxChars: number = 1900, source: string = "discord"): string[] {
  if (!text || text.length <= maxChars) return [text];

  const chunks: string[] = [];
  let remaining = text;
  let chunkIndex = 0;

  while (remaining.length > 0) {
    if (remaining.length <= maxChars) {
      chunks.push(remaining);
      break;
    }

    // Find a good split point
    let splitAt = maxChars;
    const cutZoneStart = Math.max(maxChars - 300, Math.floor(maxChars * 0.8));

    // Preserve code blocks — don't split inside them
    const codeBlockSplit = findCodeBlockSafeSplit(remaining, cutZoneStart, maxChars);
    if (codeBlockSplit > cutZoneStart) {
      splitAt = codeBlockSplit;
    } else {
      const paragraphBreak = remaining.lastIndexOf("\n\n", maxChars);
      if (paragraphBreak > cutZoneStart) {
        splitAt = paragraphBreak;
      } else {
        const lineBreak = remaining.lastIndexOf("\n", maxChars);
        if (lineBreak > cutZoneStart) {
          splitAt = lineBreak;
        }
      }
    }

    chunks.push(remaining.slice(0, splitAt).trimEnd());
    remaining = remaining.slice(splitAt).trimStart();
    chunkIndex++;

    // Safety: don't create more than 10 chunks
    if (chunkIndex >= 9 && remaining.length > maxChars) {
      chunks.push(truncate(remaining, maxChars, `${source}:overflow`));
      logEvent({
        timestamp: Date.now(),
        source: `${source}:overflow`,
        originalLength: text.length,
        truncatedLength: chunks.reduce((sum, c) => sum + c.length, 0),
        percentLost: Math.round(((text.length - chunks.reduce((sum, c) => sum + c.length, 0)) / text.length) * 100),
        severity: "significant",
        structureDamaged: false,
        preview: `Message exceeded 10 chunks (${text.length} chars total)`,
      });
      break;
    }
  }

  return chunks;
}

/**
 * Truncate for embed fields (Discord embed description: 4096, field value: 1024).
 * Attaches a file reference if content was significantly cut.
 */
function truncateForEmbed(
  text: string,
  maxChars: number,
  source: string
): { text: string; overflow: string | null } {
  if (!text || text.length <= maxChars) return { text, overflow: null };

  const result = truncate(text, maxChars, source);
  const overflow = text.slice(maxChars);

  return { text: result, overflow };
}

// ─── Structure Damage Detection ─────────────────────────────────────

function checkStructureDamage(text: string, cutPoint: number): boolean {
  const before = text.slice(0, cutPoint);

  // Check unclosed code blocks
  const codeBlocks = (before.match(/```/g) || []).length;
  if (codeBlocks % 2 !== 0) return true;

  // Check unclosed YAML frontmatter
  const frontmatterOpens = (before.match(/^---$/gm) || []).length;
  if (frontmatterOpens % 2 !== 0) return true;

  // Check if we're inside a markdown table
  const lines = before.split("\n");
  const lastLine = lines[lines.length - 1];
  if (lastLine.includes("|") && lines.length > 1 && lines[lines.length - 2].includes("|")) {
    return true;
  }

  return false;
}

function findLastSentenceEnd(text: string, start: number, end: number): number {
  const region = text.slice(start, end);
  const matches = [...region.matchAll(/[.!?]\s/g)];
  if (matches.length === 0) return -1;
  const last = matches[matches.length - 1];
  return start + (last.index || 0) + 1;
}

function findCodeBlockSafeSplit(text: string, start: number, end: number): number {
  // Count code block markers up to the end point
  const before = text.slice(0, end);
  const markers = (before.match(/```/g) || []).length;

  // If we're inside a code block (odd number of markers), find the closing ```
  if (markers % 2 !== 0) {
    const closeIdx = text.indexOf("```", end);
    if (closeIdx !== -1 && closeIdx < end + 500) {
      // Close is nearby — extend to include it
      return closeIdx + 3;
    }
    // Close is far away — find split before the code block opened
    const lastOpen = before.lastIndexOf("```");
    const beforeOpen = text.lastIndexOf("\n", lastOpen);
    if (beforeOpen > start) return beforeOpen;
  }

  return -1;
}

// ─── Event Logging & Stats ──────────────────────────────────────────

function logEvent(event: TruncationEvent): void {
  try {
    mkdirSync(LOG_DIR, { recursive: true });

    // Append to JSONL log
    appendFileSync(TRUNCATION_LOG, JSON.stringify(event) + "\n");

    // Update rolling window
    const events = recentEvents.get(event.source) || [];
    events.push(event);
    if (events.length > ROLLING_WINDOW) events.shift();
    recentEvents.set(event.source, events);

    // Update stats file periodically (every 10 events across all sources)
    const totalRecent = [...recentEvents.values()].reduce((sum, arr) => sum + arr.length, 0);
    if (totalRecent % 10 === 0) {
      updateStats();
    }

    // Emit warning for critical truncation
    if (event.severity === "critical") {
      console.error(
        `[TRUNCATION] CRITICAL in ${event.source}: ${event.percentLost}% lost ` +
        `(${event.originalLength} → ${event.truncatedLength} chars)` +
        (event.structureDamaged ? " [STRUCTURE DAMAGED]" : "")
      );
    }
  } catch {
    // Monitor should never break the system
  }
}

function updateStats(): void {
  try {
    const stats: TruncationStats = {
      totalEvents: 0,
      bySource: {},
      lastUpdated: Date.now(),
    };

    for (const [source, events] of recentEvents) {
      const criticalCount = events.filter((e) => e.severity === "critical").length;
      const avgLost = events.reduce((sum, e) => sum + e.percentLost, 0) / events.length;

      stats.bySource[source] = {
        count: events.length,
        avgPercentLost: Math.round(avgLost * 10) / 10,
        criticalCount,
        lastEvent: events[events.length - 1]?.timestamp || 0,
      };
      stats.totalEvents += events.length;
    }

    writeFileSync(STATS_FILE, JSON.stringify(stats, null, 2));
  } catch {
    // Non-critical
  }
}

// ─── Report Generation ──────────────────────────────────────────────

/**
 * Generate a human-readable report of truncation patterns.
 * Called by health-report skill or on demand.
 */
function getReport(): string {
  const lines: string[] = ["# Truncation Monitor Report", ""];

  if (recentEvents.size === 0) {
    // Try loading from stats file
    if (existsSync(STATS_FILE)) {
      try {
        const stats: TruncationStats = JSON.parse(readFileSync(STATS_FILE, "utf-8"));
        lines.push(`Last updated: ${new Date(stats.lastUpdated).toISOString()}`);
        lines.push(`Total events tracked: ${stats.totalEvents}`, "");

        for (const [source, data] of Object.entries(stats.bySource)) {
          const status = data.criticalCount > 0 ? "⚠" : "✓";
          lines.push(
            `${status} **${source}**: ${data.count} events, avg ${data.avgPercentLost}% lost` +
            (data.criticalCount > 0 ? `, ${data.criticalCount} critical` : "")
          );
        }
        return lines.join("\n");
      } catch {
        return "No truncation data available yet.";
      }
    }
    return "No truncation events recorded yet.";
  }

  let totalCritical = 0;
  const sourceReports: Array<{ source: string; line: string; critical: number }> = [];

  for (const [source, events] of recentEvents) {
    const critical = events.filter((e) => e.severity === "critical").length;
    const significant = events.filter((e) => e.severity === "significant").length;
    const avgLost = events.reduce((sum, e) => sum + e.percentLost, 0) / events.length;
    totalCritical += critical;

    const status = critical > 0 ? "CRITICAL" : significant > 0 ? "WARN" : "OK";
    sourceReports.push({
      source,
      line: `| ${source} | ${events.length} | ${Math.round(avgLost)}% | ${critical} | ${significant} | ${status} |`,
      critical,
    });
  }

  // Sort: critical sources first
  sourceReports.sort((a, b) => b.critical - a.critical);

  lines.push("| Source | Events | Avg % Lost | Critical | Significant | Status |");
  lines.push("|--------|--------|-----------|----------|-------------|--------|");
  for (const r of sourceReports) {
    lines.push(r.line);
  }

  if (totalCritical > 0) {
    lines.push("", `**${totalCritical} critical truncation events** — these should be investigated.`);

    // Show worst offenders
    lines.push("", "### Worst Truncations:");
    const allEvents = [...recentEvents.values()].flat();
    const worst = allEvents
      .filter((e) => e.severity === "critical")
      .sort((a, b) => b.percentLost - a.percentLost)
      .slice(0, 5);

    for (const e of worst) {
      lines.push(
        `- **${e.source}**: ${e.originalLength} → ${e.truncatedLength} chars (${e.percentLost}% lost)` +
        (e.structureDamaged ? " [structure damaged]" : "") +
        `\n  Lost: \`${e.preview.slice(0, 100)}...\``
      );
    }
  }

  return lines.join("\n");
}

// ─── Public API ─────────────────────────────────────────────────────

/**
 * Drain recent events matching a source prefix.
 * Returns and clears them so the caller can summarize once.
 * Used by context-assembler to notify the LLM about truncated learnings.
 */
function drainRecentEvents(sourcePrefix: string): TruncationEvent[] {
  const matching: TruncationEvent[] = [];
  for (const [source, events] of recentEvents) {
    if (source.startsWith(sourcePrefix)) {
      matching.push(...events.filter((e) => e.severity !== "benign"));
    }
  }
  // Clear the drained events so they aren't reported twice
  for (const [source] of recentEvents) {
    if (source.startsWith(sourcePrefix)) {
      recentEvents.set(source, []);
    }
  }
  return matching;
}

export const monitor = {
  truncate,
  splitForDiscord,
  truncateForEmbed,
  getReport,
  drainRecentEvents,
  getStats: (): TruncationStats | null => {
    if (existsSync(STATS_FILE)) {
      try {
        return JSON.parse(readFileSync(STATS_FILE, "utf-8"));
      } catch { return null; }
    }
    return null;
  },
};
