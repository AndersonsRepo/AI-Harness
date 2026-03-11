/**
 * Handles promotion approval workflow for vault learnings.
 * When a learning reaches recurrence-count >= 3, the promotion-check
 * heartbeat posts a Discord notification. Users reply with
 * "approve <id>" or "reject <id>" to act on it.
 *
 * On approval: the learning's key insight is appended to CLAUDE.md's
 * Promoted Learnings section, and the vault file's status is set to "promoted".
 */

import {
  readFileSync,
  writeFileSync,
  existsSync,
  readdirSync,
} from "fs";
import { join } from "path";

const HARNESS_ROOT = process.env.HARNESS_ROOT || ".";
const VAULT_LEARNINGS = join(HARNESS_ROOT, "vault", "learnings");
const CLAUDE_MD = join(HARNESS_ROOT, "CLAUDE.md");

interface LearningFrontmatter {
  id: string;
  type: string;
  status: string;
  area: string;
  "pattern-key": string;
  "recurrence-count": number;
  tags: string[];
}

/**
 * Parse YAML frontmatter from a vault learning file.
 * Simple parser — handles the subset used by vault files.
 */
function parseFrontmatter(content: string): { frontmatter: Record<string, any>; body: string } | null {
  const match = content.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (!match) return null;

  const yaml = match[1];
  const body = match[2];
  const frontmatter: Record<string, any> = {};

  for (const line of yaml.split("\n")) {
    const kvMatch = line.match(/^(\S[\w-]*)\s*:\s*(.*)$/);
    if (!kvMatch) continue;

    const [, key, rawValue] = kvMatch;
    let value: any = rawValue.trim();

    // Parse arrays: [tag1, tag2]
    if (value.startsWith("[") && value.endsWith("]")) {
      value = value.slice(1, -1).split(",").map((s: string) => s.trim().replace(/^["']|["']$/g, ""));
    }
    // Parse numbers
    else if (/^\d+$/.test(value)) {
      value = parseInt(value, 10);
    }
    // Strip quotes
    else if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }

    frontmatter[key] = value;
  }

  return { frontmatter, body };
}

/**
 * Find a learning file by its ID (e.g., "LRN-20250309-001").
 */
export function findLearningById(id: string): { path: string; content: string; frontmatter: Record<string, any>; body: string } | null {
  if (!existsSync(VAULT_LEARNINGS)) return null;

  const files = readdirSync(VAULT_LEARNINGS).filter(f => f.endsWith(".md"));
  for (const file of files) {
    const filePath = join(VAULT_LEARNINGS, file);
    const content = readFileSync(filePath, "utf-8");
    const parsed = parseFrontmatter(content);
    if (parsed && parsed.frontmatter.id === id) {
      return { path: filePath, content, ...parsed };
    }
  }
  return null;
}

/**
 * Get all learnings eligible for promotion (recurrence >= 3, not already promoted/archived).
 */
export function getPromotionCandidates(): Array<{ id: string; path: string; frontmatter: Record<string, any>; body: string }> {
  if (!existsSync(VAULT_LEARNINGS)) return [];

  const candidates: Array<{ id: string; path: string; frontmatter: Record<string, any>; body: string }> = [];
  const files = readdirSync(VAULT_LEARNINGS).filter(f => f.endsWith(".md"));

  for (const file of files) {
    const filePath = join(VAULT_LEARNINGS, file);
    const content = readFileSync(filePath, "utf-8");
    const parsed = parseFrontmatter(content);
    if (!parsed) continue;

    const { frontmatter } = parsed;
    if (
      (frontmatter["recurrence-count"] || 0) >= 3 &&
      frontmatter.status !== "promoted" &&
      frontmatter.status !== "archived"
    ) {
      candidates.push({
        id: frontmatter.id,
        path: filePath,
        frontmatter,
        body: parsed.body,
      });
    }
  }

  return candidates;
}

/**
 * Approve a learning for promotion.
 * 1. Appends to CLAUDE.md ## Promoted Learnings section
 * 2. Updates the vault file's status to "promoted"
 */
export function approveLearning(id: string): { success: boolean; message: string } {
  const learning = findLearningById(id);
  if (!learning) {
    return { success: false, message: `Learning \`${id}\` not found in vault.` };
  }

  if (learning.frontmatter.status === "promoted") {
    return { success: false, message: `Learning \`${id}\` is already promoted.` };
  }

  // Extract the title from the body (first # heading)
  const titleMatch = learning.body.match(/^#\s+(.+)$/m);
  const title = titleMatch ? titleMatch[1].trim() : id;

  // Extract the "What was learned" section
  const learnedMatch = learning.body.match(/## What was learned\n([\s\S]*?)(?=\n##|$)/);
  const learned = learnedMatch
    ? learnedMatch[1].trim().split("\n")[0].slice(0, 200) // First line, max 200 chars
    : title;

  const area = learning.frontmatter.area || "general";
  const today = new Date().toISOString().slice(0, 10);
  const promotionLine = `- **[${area}]**: ${learned} (promoted ${today}, from ${id})`;

  // Append to CLAUDE.md
  if (!existsSync(CLAUDE_MD)) {
    return { success: false, message: "CLAUDE.md not found." };
  }

  let claudeMd = readFileSync(CLAUDE_MD, "utf-8");

  // Find the Promoted Learnings section
  const sectionMarker = "## Promoted Learnings";
  const sectionIdx = claudeMd.indexOf(sectionMarker);

  if (sectionIdx === -1) {
    // Add section at end
    claudeMd += `\n\n${sectionMarker}\n\n${promotionLine}\n`;
  } else {
    // Find the end of the section (next ## or end of file)
    const afterMarker = sectionIdx + sectionMarker.length;
    const nextSection = claudeMd.indexOf("\n## ", afterMarker + 1);
    const insertPoint = nextSection === -1 ? claudeMd.length : nextSection;

    // Insert the promotion line before the next section (or at end)
    claudeMd = claudeMd.slice(0, insertPoint) + promotionLine + "\n" + claudeMd.slice(insertPoint);
  }

  writeFileSync(CLAUDE_MD, claudeMd);

  // Update vault file status to "promoted"
  const updatedContent = learning.content.replace(
    /^status:\s*.+$/m,
    "status: promoted"
  );
  writeFileSync(learning.path, updatedContent);

  console.log(`[PROMOTE] Approved ${id}: "${title}" → CLAUDE.md`);
  return { success: true, message: `Promoted \`${id}\`: "${title}" → Added to CLAUDE.md` };
}

/**
 * Reject a learning for promotion (mark as reviewed, don't promote).
 */
export function rejectLearning(id: string): { success: boolean; message: string } {
  const learning = findLearningById(id);
  if (!learning) {
    return { success: false, message: `Learning \`${id}\` not found in vault.` };
  }

  // Don't change status — just acknowledge. The promotion-check won't
  // re-notify because it only fires on heartbeat, not continuously.
  // If user wants to permanently dismiss, they can set status to archived.
  console.log(`[PROMOTE] Rejected ${id}`);
  return { success: true, message: `Rejected \`${id}\`. It won't be promoted but stays in the vault.` };
}

/**
 * List current vault stats for /vault-status command.
 */
export function getVaultStats(): {
  total: number;
  byStatus: Record<string, number>;
  byType: Record<string, number>;
  promotionCandidates: number;
  recentLearnings: Array<{ id: string; title: string; recurrence: number }>;
} {
  if (!existsSync(VAULT_LEARNINGS)) {
    return { total: 0, byStatus: {}, byType: {}, promotionCandidates: 0, recentLearnings: [] };
  }

  const files = readdirSync(VAULT_LEARNINGS).filter(f => f.endsWith(".md"));
  const byStatus: Record<string, number> = {};
  const byType: Record<string, number> = {};
  let promotionCandidates = 0;
  const recentLearnings: Array<{ id: string; title: string; recurrence: number }> = [];

  for (const file of files) {
    const content = readFileSync(join(VAULT_LEARNINGS, file), "utf-8");
    const parsed = parseFrontmatter(content);
    if (!parsed) continue;

    const { frontmatter, body } = parsed;
    const status = frontmatter.status || "unknown";
    const type = frontmatter.type || "unknown";

    byStatus[status] = (byStatus[status] || 0) + 1;
    byType[type] = (byType[type] || 0) + 1;

    if ((frontmatter["recurrence-count"] || 0) >= 3 && status !== "promoted" && status !== "archived") {
      promotionCandidates++;
    }

    // Recent: last 5 by last-seen
    const titleMatch = body.match(/^#\s+(.+)$/m);
    recentLearnings.push({
      id: frontmatter.id || file,
      title: titleMatch ? titleMatch[1].trim() : file,
      recurrence: frontmatter["recurrence-count"] || 1,
    });
  }

  // Sort by recurrence descending, take top 5
  recentLearnings.sort((a, b) => b.recurrence - a.recurrence);
  recentLearnings.splice(5);

  return { total: files.length, byStatus, byType, promotionCandidates, recentLearnings };
}
