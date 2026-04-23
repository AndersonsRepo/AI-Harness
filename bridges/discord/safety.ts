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
