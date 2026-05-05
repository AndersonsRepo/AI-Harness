/**
 * Canonical set of destructive Bash patterns the harness refuses to run,
 * shared between Claude and Codex paths. The Claude path passes these to
 * `claude -p --disallowedTools` (see claude-config.ts); the Codex path
 * writes them into CODEX_SAFETY_PATTERNS for codex-runner.py to enforce
 * at the event-stream level (since `codex exec` has no equivalent CLI
 * flag). Keep this list in sync with codex-runner.py's _DEFAULT_PATTERNS.
 */

export interface DestructivePattern {
  id: string;
  // Regex applied against the command string a tool call is about to execute.
  // Match = kill the spawned subprocess immediately. Python and JS regex syntax
  // are both supported, so don't use `(?i)` inline — set caseInsensitive instead.
  regex: string;
  caseInsensitive?: boolean;
  description: string;
}

export const DESTRUCTIVE_BASH_PATTERNS: DestructivePattern[] = [
  {
    id: "rm-rf",
    regex: "\\brm\\s+(-[rRfF]+|--recursive|--force)",
    description: "rm with recursive or force flags",
  },
  {
    id: "git-push-force",
    regex: "\\bgit\\s+push\\s+(--force|-f\\b)",
    description: "git push --force / -f",
  },
  {
    id: "git-reset-hard",
    regex: "\\bgit\\s+reset\\s+--hard\\b",
    description: "git reset --hard",
  },
  {
    id: "kill-9",
    regex: "\\bkill\\s+-9\\b",
    description: "kill -9",
  },
  {
    id: "pkill-9",
    regex: "\\bpkill\\s+-9\\b",
    description: "pkill -9",
  },
  {
    id: "drop-table",
    regex: "\\bDROP\\s+TABLE\\b",
    caseInsensitive: true,
    description: "SQL DROP TABLE",
  },
  {
    id: "delete-from",
    regex: "\\bDELETE\\s+FROM\\b",
    caseInsensitive: true,
    description: "SQL DELETE FROM",
  },
];

/**
 * Serialize patterns for consumption by codex-runner.py via the
 * CODEX_SAFETY_PATTERNS env var.
 */
export function safetyPatternsJson(): string {
  return JSON.stringify(DESTRUCTIVE_BASH_PATTERNS);
}

/**
 * Claude `--disallowedTools` syntax for the subset that's a Bash
 * command pattern. Preserves the existing semantics for the claude-config
 * caller; non-bash patterns (SQL keywords) are emitted as Bash(...) matchers
 * that catch them appearing inside a shell command.
 */
export function claudeDisallowedToolArgs(): string[] {
  return [
    "Bash(rm -rf:*)",
    "Bash(git push --force:*)",
    "Bash(git reset --hard:*)",
    "Bash(DROP:*)",
    "Bash(DELETE FROM:*)",
    "Bash(kill -9:*)",
  ];
}

// ─── Per-Agent Tool Policy (Codex) ───────────────────────────────────
//
// Claude enforces AGENT_TOOL_RESTRICTIONS via `--disallowedTools` /
// `--allowedTools` at the CLI layer. Codex CLI has no equivalent flag, so
// we translate the per-agent rules into a JSON policy that codex-runner.py
// matches against `command_execution` (Bash) and `mcp_tool_call` (MCP)
// events in the JSONL stream, killing the subprocess on violation.
//
// Only Bash commands and MCP tool calls are surfaced as JSONL events.
// Codex's built-in file/search/web tools (analogues of Claude's Read,
// Grep, Glob, WebSearch, WebFetch, Edit, Write, NotebookEdit) don't
// appear in the stream — those are governed by the sandbox (`read-only`
// vs `workspace-write`) instead. So the translation drops non-Bash,
// non-MCP entries by design.

export interface AgentToolPolicyPattern {
  id: string;
  regex: string;
  caseInsensitive?: boolean;
}

export interface AgentToolPolicy {
  /** Whitelist: a tool call must match an allowed pattern, else kill.
   *  Blacklist: a tool call matching a disallowed pattern is killed. */
  mode: "whitelist" | "blacklist";
  /** Patterns for `command_execution` events. Compiled by codex-runner. */
  bashPatterns: AgentToolPolicyPattern[];
  /** Exact MCP tool names (`mcp__<server>__<tool>`). */
  mcpPatterns: string[];
}

const SQL_KEYWORDS = new Set(["DROP", "DELETE FROM", "TRUNCATE", "ALTER"]);

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\s+/g, "\\s+");
}

/**
 * Translate one `Bash(<prefix>:*)` entry into a regex pattern. Returns null
 * for entries that aren't Bash patterns (Read, Edit, mcp__*, etc).
 */
function translateBashEntry(entry: string): AgentToolPolicyPattern | null {
  const m = entry.match(/^Bash\((.+):\*\)$/);
  if (!m) return null;
  const prefix = m[1]!.trim();
  if (!prefix) return null;
  const id = `bash-${prefix.replace(/\s+/g, "-").toLowerCase()}`;
  // Use \b...\b boundaries so the pattern catches the keyword anywhere in
  // a chained shell expression (e.g. `cd foo && npm install`). The Claude
  // CLI's allowed/disallowed matcher is more nuanced (parses the command
  // tree); this approximation favors over-blocking, which is the safer
  // failure mode for a defense-in-depth check.
  const upper = prefix.toUpperCase();
  const isSql = [...SQL_KEYWORDS].some((kw) => upper.startsWith(kw));
  const pattern: AgentToolPolicyPattern = {
    id,
    regex: `\\b${escapeRegex(prefix)}\\b`,
  };
  if (isSql) pattern.caseInsensitive = true;
  return pattern;
}

function translateMcpEntry(entry: string): string | null {
  return entry.startsWith("mcp__") ? entry : null;
}

/**
 * Build a Codex-enforceable tool policy for an agent, derived from
 * AGENT_TOOL_RESTRICTIONS. Returns null when the agent has no restrictions
 * (in which case only the global destructive-pattern scan applies).
 *
 * Whitelist agents (researcher, reviewer, tester, education, scheduler):
 * any Bash command not matching an allowed pattern → killed; any MCP tool
 * not in the allowed list → killed.
 *
 * Blacklist agents (orchestrator): any Bash command matching a disallowed
 * pattern → killed; any MCP tool in the disallowed list → killed.
 */
export function buildAgentToolPolicy(
  restrictions: { allowed?: string[]; disallowed?: string[] } | undefined,
): AgentToolPolicy | null {
  if (!restrictions) return null;

  if (restrictions.allowed?.length) {
    const bashPatterns: AgentToolPolicyPattern[] = [];
    const mcpPatterns: string[] = [];
    for (const entry of restrictions.allowed) {
      const bash = translateBashEntry(entry);
      if (bash) {
        bashPatterns.push(bash);
        continue;
      }
      const mcp = translateMcpEntry(entry);
      if (mcp) mcpPatterns.push(mcp);
      // Non-Bash, non-MCP entries (Read, Grep, Glob, WebSearch, …) are
      // intentionally dropped — they have no Codex JSONL representation.
    }
    return { mode: "whitelist", bashPatterns, mcpPatterns };
  }

  if (restrictions.disallowed?.length) {
    const bashPatterns: AgentToolPolicyPattern[] = [];
    const mcpPatterns: string[] = [];
    for (const entry of restrictions.disallowed) {
      const bash = translateBashEntry(entry);
      if (bash) {
        bashPatterns.push(bash);
        continue;
      }
      const mcp = translateMcpEntry(entry);
      if (mcp) mcpPatterns.push(mcp);
      // Same drop rule as whitelist: Edit/Write/NotebookEdit are sandbox-
      // governed under Codex; nothing to enforce at the JSONL layer.
    }
    if (bashPatterns.length === 0 && mcpPatterns.length === 0) return null;
    return { mode: "blacklist", bashPatterns, mcpPatterns };
  }

  return null;
}

export function agentToolPolicyJson(
  restrictions: { allowed?: string[]; disallowed?: string[] } | undefined,
): string | null {
  const policy = buildAgentToolPolicy(restrictions);
  return policy ? JSON.stringify(policy) : null;
}
