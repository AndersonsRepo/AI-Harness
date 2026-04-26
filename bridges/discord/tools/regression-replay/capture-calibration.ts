// Capture a calibration anchor pair from a real expert critique.
//
// Invoked by the quality-auditor agent (or manually) when the user issues
// a critique on agent output. Writes a new pair-NNN-<slug>.json file to
// vault/shared/regression-replay/calibration/ so the PoLL judges can
// pick it up via Critique Shadowing on their next run.
//
// Usage:
//   HARNESS_ROOT=$(pwd) npx tsx \
//     bridges/discord/tools/regression-replay/capture-calibration.ts \
//     --agent-role researcher \
//     --shape shape-01 \
//     --context "<original prompt>" \
//     --candidate "<agent output, truncated>" \
//     --critique "<user's critique verbatim>" \
//     --verdict regress \
//     --rationale "<why this verdict>"
//
// Args may be passed via @file syntax to avoid argv length limits:
//   --candidate @/tmp/candidate.txt   reads file contents

import {
  readFileSync,
  writeFileSync,
  readdirSync,
  existsSync,
  mkdirSync,
} from "fs";
import { join } from "path";

const HARNESS_ROOT = process.env.HARNESS_ROOT ?? process.cwd();
const CALIBRATION_DIR = join(
  HARNESS_ROOT,
  "vault",
  "shared",
  "regression-replay",
  "calibration",
);

interface Args {
  agentRole?: string;
  shape?: string;
  context?: string;
  candidate?: string;
  critique?: string;
  verdict?: "regress" | "unclear";
  rationale?: string;
}

function readMaybeFile(value: string): string {
  if (value.startsWith("@")) {
    const path = value.slice(1);
    return readFileSync(path, "utf-8");
  }
  return value;
}

function parseArgs(argv: string[]): Args {
  const out: Args = {};
  const args = argv.slice(2);
  for (let i = 0; i < args.length; i++) {
    const flag = args[i];
    const value = args[i + 1];
    switch (flag) {
      case "--agent-role":
        out.agentRole = value;
        i++;
        break;
      case "--shape":
        out.shape = value;
        i++;
        break;
      case "--context":
        out.context = readMaybeFile(value);
        i++;
        break;
      case "--candidate":
        out.candidate = readMaybeFile(value);
        i++;
        break;
      case "--critique":
        out.critique = readMaybeFile(value);
        i++;
        break;
      case "--verdict":
        if (value !== "regress" && value !== "unclear") {
          console.error(`--verdict must be 'regress' or 'unclear', got: ${value}`);
          process.exit(2);
        }
        out.verdict = value;
        i++;
        break;
      case "--rationale":
        out.rationale = readMaybeFile(value);
        i++;
        break;
      default:
        console.error(`Unknown argument: ${flag}`);
        process.exit(2);
    }
  }
  return out;
}

function nextPairId(): string {
  if (!existsSync(CALIBRATION_DIR)) return "pair-001";
  const files = readdirSync(CALIBRATION_DIR).filter(
    (f) => f.startsWith("pair-") && f.endsWith(".json"),
  );
  let max = 0;
  for (const f of files) {
    const m = f.match(/^pair-(\d{3,})/);
    if (m) {
      const n = parseInt(m[1], 10);
      if (n > max) max = n;
    }
  }
  return `pair-${String(max + 1).padStart(3, "0")}`;
}

function slugify(text: string): string {
  return text
    .slice(0, 60)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "")
    .slice(0, 40);
}

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return text.slice(0, max - 30) + "\n\n[...truncated for calibration anchor]";
}

function main(): void {
  const args = parseArgs(process.argv);
  const required = [
    "agentRole",
    "context",
    "candidate",
    "critique",
    "verdict",
    "rationale",
  ] as const;
  for (const k of required) {
    if (!args[k] || (typeof args[k] === "string" && (args[k] as string).trim() === "")) {
      console.error(`Missing required arg: --${k.replace(/([A-Z])/g, "-$1").toLowerCase()}`);
      process.exit(2);
    }
  }

  if (!existsSync(CALIBRATION_DIR)) {
    mkdirSync(CALIBRATION_DIR, { recursive: true });
  }

  const id = nextPairId();
  const slug = slugify(args.critique || args.agentRole || "pair");
  const filename = `${id}-${slug}.json`;
  const fullPath = join(CALIBRATION_DIR, filename);

  const pair = {
    id,
    captured_at: new Date().toISOString().slice(0, 10),
    agent_role: args.agentRole,
    shape: args.shape ?? null,
    context: truncate(args.context!.trim(), 1000),
    candidate_output: truncate(args.candidate!.trim(), 2000),
    your_critique: args.critique!.trim(),
    verdict: args.verdict,
    rationale: args.rationale!.trim(),
  };

  writeFileSync(fullPath, JSON.stringify(pair, null, 2) + "\n", "utf-8");
  console.error(`[capture-calibration] Wrote ${filename}`);
  // Emit the pair JSON to stdout so the auditor agent can show it back to
  // the user without re-reading from disk.
  process.stdout.write(JSON.stringify(pair, null, 2) + "\n");
}

main();
