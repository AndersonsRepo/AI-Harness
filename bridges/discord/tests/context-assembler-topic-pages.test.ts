import { test } from "node:test";
import assert from "node:assert/strict";
import {
  prioritizeTopicFallbackItems,
  readTopicPageContext,
  resolveTopicSlug,
} from "../context-assembler.js";

test("resolveTopicSlug prefers the ai-harness compiled page for project and prompt matches", () => {
  assert.equal(resolveTopicSlug("ai-harness", []), "ai-harness");
  assert.equal(resolveTopicSlug(undefined, ["codex", "ai-harness"]), "ai-harness");
  assert.equal(resolveTopicSlug(undefined, ["graphn", "runtime"]), null);
});

test("resolveTopicSlug resolves any topic page that exists on disk (generalized router)", () => {
  // On-disk slug match via project name (no alias needed for single-token slugs).
  assert.equal(resolveTopicSlug("mento", []), "mento");
  assert.equal(resolveTopicSlug("codex-runtime", []), "codex-runtime");
  assert.equal(resolveTopicSlug("hey-lexxi", []), "hey-lexxi");
  // On-disk slug match via a prompt keyword.
  assert.equal(resolveTopicSlug(undefined, ["regression-replay"]), "regression-replay");
  // Friendly-name aliases (multi-word / nickname / abbreviation).
  assert.equal(resolveTopicSlug("Hey Lexxi", []), "hey-lexxi");
  assert.equal(resolveTopicSlug(undefined, ["lexxi"]), "hey-lexxi");
  assert.equal(resolveTopicSlug(undefined, ["sigmas"]), "sigmas-internship");
  // Project name wins over an unrelated keyword.
  assert.equal(resolveTopicSlug("mento", ["unrelated"]), "mento");
  // No page → null (unchanged).
  assert.equal(resolveTopicSlug(undefined, ["nonexistent-topic-xyz"]), null);
});

test("resolveTopicSlug routes the candidate project pages (on-disk slug + aliases)", () => {
  // On-disk slug via project name.
  assert.equal(resolveTopicSlug("lead-gen", []), "lead-gen");
  assert.equal(resolveTopicSlug("website-agency", []), "website-agency");
  assert.equal(resolveTopicSlug("cptc-toolkit", []), "cptc-toolkit");
  assert.equal(resolveTopicSlug("prompt-to-app", []), "prompt-to-app");
  assert.equal(resolveTopicSlug("subscription-spillover", []), "subscription-spillover");
  // Friendly-name / nickname aliases (single keywords won't slug-match a multi-word page).
  assert.equal(resolveTopicSlug(undefined, ["leadgen"]), "lead-gen");
  assert.equal(resolveTopicSlug(undefined, ["cptc"]), "cptc-toolkit");
  assert.equal(resolveTopicSlug(undefined, ["quome"]), "prompt-to-app");
  assert.equal(resolveTopicSlug(undefined, ["spillover"]), "subscription-spillover");
});

test("readTopicPageContext loads the generated ai-harness topic page with provenance", () => {
  const topic = readTopicPageContext("ai-harness");
  assert.ok(topic);
  assert.equal(topic?.slug, "ai-harness");
  assert.equal(topic?.title, "AI Harness");
  assert.ok(topic?.content.includes("## Current State"));
  assert.ok(topic?.sourcePaths.has("plans/d31-orchestrator-codex-2026-04-29.md"));
});

test("prioritizeTopicFallbackItems demotes topic-source learnings but preserves them as fallback", () => {
  const ordered = prioritizeTopicFallbackItems(
    [
      { path: "learnings/LRN-topic-duplicate.md", label: "duplicate" },
      { path: "learnings/LRN-fresh-evidence.md", label: "fresh" },
      { path: "learnings/LRN-second-fresh.md", label: "second" },
    ],
    new Set(["learnings/LRN-topic-duplicate.md"]),
    (item) => item.path,
    3,
  );

  assert.deepEqual(
    ordered.map((item) => item.label),
    ["fresh", "second", "duplicate"],
  );
});
