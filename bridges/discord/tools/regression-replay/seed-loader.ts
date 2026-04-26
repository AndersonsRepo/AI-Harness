// Read/write helpers for seed shape definitions and baseline files.
// Source of truth: vault/shared/regression-replay/{seeds,baselines}/

import { readFileSync, writeFileSync, readdirSync, existsSync, mkdirSync } from "fs";
import { join, basename } from "path";

const HARNESS_ROOT = process.env.HARNESS_ROOT ?? process.cwd();
const REPLAY_ROOT = join(
  HARNESS_ROOT,
  "vault",
  "shared",
  "regression-replay",
);
const SEEDS_DIR = join(REPLAY_ROOT, "seeds");
const BASELINES_DIR = join(REPLAY_ROOT, "baselines");

export interface Seed {
  id: string;
  shape: string;
  category: string;
  difficulty: string;
  released_at: string;
  source: string | null;
  expected_agents: string[];
  runtime: string;
  parameter_slots: Record<string, string>;
  prompt_template: string;
  tests?: string[];
  current_pin: PinReference | null;
  rotation_policy: string;
  notes?: string;
}

export interface PinReference {
  baseline_path: string;
  captured_at: string;
  harness_version: number;
}

export interface Baseline {
  seed_id: string;
  captured_at: string;
  harness_version: number;
  rubric_version: number;
  parameters: Record<string, string>;
  resolved_prompt: string;
  channel_id: string;
  agent_name: string;
  runtime: string;
  context_block: string;
  metrics: {
    retrievedIds: string[];
    contextSize: number;
    sectionCount: number;
  };
  // The agent's actual response, captured at pin time. Required for tier 2
  // comparison; tier 1 ignores this field. Older baselines from before tier 2
  // existed may have this as null — tier 2 must skip those seeds and warn.
  agent_response: {
    text: string;
    duration_ms: number;
  } | null;
}

export function loadSeeds(): Seed[] {
  if (!existsSync(SEEDS_DIR)) return [];
  const files = readdirSync(SEEDS_DIR).filter((f) => f.endsWith(".json"));
  return files.map((f) => {
    const raw = readFileSync(join(SEEDS_DIR, f), "utf-8");
    return JSON.parse(raw) as Seed;
  });
}

export function loadSeed(seedId: string): Seed | null {
  const seeds = loadSeeds();
  return seeds.find((s) => s.id === seedId) ?? null;
}

export function loadBaseline(seedId: string): Baseline | null {
  const seed = loadSeed(seedId);
  if (!seed?.current_pin) return null;
  const path = resolvePath(seed.current_pin.baseline_path);
  if (!existsSync(path)) return null;
  const raw = readFileSync(path, "utf-8");
  return JSON.parse(raw) as Baseline;
}

export function saveBaseline(baseline: Baseline): string {
  if (!existsSync(BASELINES_DIR)) {
    mkdirSync(BASELINES_DIR, { recursive: true });
  }
  const filename = `${baseline.seed_id}-${baseline.captured_at}-h${baseline.harness_version}.json`;
  const fullPath = join(BASELINES_DIR, filename);
  writeFileSync(fullPath, JSON.stringify(baseline, null, 2), "utf-8");
  return relativeToReplayRoot(fullPath);
}

export function updateSeedPin(seedId: string, pin: PinReference): void {
  const files = readdirSync(SEEDS_DIR).filter((f) => f.endsWith(".json"));
  for (const f of files) {
    const path = join(SEEDS_DIR, f);
    const raw = readFileSync(path, "utf-8");
    const seed = JSON.parse(raw) as Seed;
    if (seed.id === seedId) {
      seed.current_pin = pin;
      writeFileSync(path, JSON.stringify(seed, null, 2) + "\n", "utf-8");
      return;
    }
  }
  throw new Error(`Seed ${seedId} not found`);
}

export function resolvePrompt(
  template: string,
  parameters: Record<string, string>,
): string {
  let result = template;
  for (const [key, value] of Object.entries(parameters)) {
    result = result.replace(new RegExp(`\\{${key}\\}`, "g"), value);
  }
  // Detect unresolved slots — caller's bug.
  const unresolved = result.match(/\{[a-z_][a-z0-9_]*\}/gi);
  if (unresolved) {
    throw new Error(
      `Unresolved parameter slots in prompt: ${unresolved.join(", ")}`,
    );
  }
  return result;
}

function resolvePath(baselinePath: string): string {
  // Stored as relative path under replay root; resolve to absolute.
  if (baselinePath.startsWith("/")) return baselinePath;
  return join(REPLAY_ROOT, baselinePath);
}

function relativeToReplayRoot(absPath: string): string {
  // Stored as e.g. "baselines/shape-01-2026-04-25-h1.json"
  return `baselines/${basename(absPath)}`;
}

export function getReplayRoot(): string {
  return REPLAY_ROOT;
}
