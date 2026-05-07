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
