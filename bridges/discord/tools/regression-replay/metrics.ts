// Pure metric functions for tier-1 structural comparison. No I/O, no model
// calls. Given two context blocks (or extracted features), compute the
// signals tier 1 reports. See vault/shared/regression-replay/rubric.md.

export interface StructuralMetrics {
  retrievedIds: string[];
  contextSize: number;
  sectionCount: number;
}

export interface MetricsDelta {
  jaccard: number;
  jaccardBand: "ok" | "noted" | "flagged";
  sizeDeltaAbs: number;
  sizeDeltaPct: number;
  sizeBand: "ok" | "noted" | "flagged";
  retrievedAdded: string[];
  retrievedRemoved: string[];
  sectionCountDelta: number;
}

const RETRIEVED_ID_REGEX = /^### \[([A-Za-z0-9_\-]+)\]/gm;
const SECTION_HEADER_REGEX = /^## /gm;

export function extractMetrics(contextBlock: string): StructuralMetrics {
  const retrievedIds = Array.from(
    contextBlock.matchAll(RETRIEVED_ID_REGEX),
    (m) => m[1],
  );
  const sectionMatches = contextBlock.match(SECTION_HEADER_REGEX);
  return {
    retrievedIds,
    contextSize: contextBlock.length,
    sectionCount: sectionMatches?.length ?? 0,
  };
}

export function jaccard(a: Iterable<string>, b: Iterable<string>): number {
  const setA = new Set(a);
  const setB = new Set(b);
  if (setA.size === 0 && setB.size === 0) return 1;
  let intersection = 0;
  for (const x of setA) if (setB.has(x)) intersection++;
  const union = setA.size + setB.size - intersection;
  if (union === 0) return 1;
  return intersection / union;
}

// Per rubric.md v2: 3pp noise band on Jaccard, 2-5% on context size.
const JACCARD_REGRESS_THRESHOLD = 0.7;
const JACCARD_NOISE_BAND = 0.03;
const SIZE_NOISE_PCT = 2;
const SIZE_FLAG_PCT = 5;

export function classifyJaccard(j: number): "ok" | "noted" | "flagged" {
  if (j >= JACCARD_REGRESS_THRESHOLD + JACCARD_NOISE_BAND) return "ok";
  if (j >= JACCARD_REGRESS_THRESHOLD - JACCARD_NOISE_BAND) return "noted";
  return "flagged";
}

export function classifySizeDelta(pct: number): "ok" | "noted" | "flagged" {
  const abs = Math.abs(pct);
  if (abs <= SIZE_NOISE_PCT) return "ok";
  if (abs <= SIZE_FLAG_PCT) return "noted";
  return "flagged";
}

export function compareMetrics(
  current: StructuralMetrics,
  baseline: StructuralMetrics,
): MetricsDelta {
  const j = jaccard(current.retrievedIds, baseline.retrievedIds);
  const sizeDeltaAbs = current.contextSize - baseline.contextSize;
  const sizeDeltaPct =
    baseline.contextSize === 0
      ? 0
      : (sizeDeltaAbs / baseline.contextSize) * 100;

  const baselineSet = new Set(baseline.retrievedIds);
  const currentSet = new Set(current.retrievedIds);
  const retrievedAdded = current.retrievedIds.filter(
    (id) => !baselineSet.has(id),
  );
  const retrievedRemoved = baseline.retrievedIds.filter(
    (id) => !currentSet.has(id),
  );

  return {
    jaccard: j,
    jaccardBand: classifyJaccard(j),
    sizeDeltaAbs,
    sizeDeltaPct,
    sizeBand: classifySizeDelta(sizeDeltaPct),
    retrievedAdded,
    retrievedRemoved,
    sectionCountDelta: current.sectionCount - baseline.sectionCount,
  };
}

export function overallOutcome(
  delta: MetricsDelta,
): "ok" | "noted" | "flagged" {
  if (delta.jaccardBand === "flagged" || delta.sizeBand === "flagged") {
    return "flagged";
  }
  if (delta.jaccardBand === "noted" || delta.sizeBand === "noted") {
    return "noted";
  }
  return "ok";
}
