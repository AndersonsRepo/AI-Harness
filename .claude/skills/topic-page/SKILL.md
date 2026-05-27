---
name: topic-page
description: Create or update a vault topic page (vault/topics/<slug>.md) — the high-priority, generous-cap project synthesis injected into agent context ABOVE raw learnings. Use when the user says "make/create a topic page for X", or when you judge a project has accumulated enough load-bearing state that it's bloating LIVE_STATE or scattered across many learnings. The AI authors the body; an optional human-edit zone is preserved verbatim across rewrites.
user-invocable: true
argument-hint: "<project-or-topic name> [--update] [--parent <slug>]"
allowed-tools:
  - Read
  - Write
  - Edit
  - Glob
  - Grep
  - Bash
---

# Topic Page — create/update the high-priority synthesis layer

A **topic page** (`vault/topics/<slug>.md`) is the durable, load-bearing synthesis of one project/topic. The context assembler injects it at **priority 2 — above raw learnings** (`bridges/discord/context-assembler.ts`, `buildTopicPageSection` → `resolveTopicSlug` → `readTopicPageContext`), with a generous **20000-char** cap. That cap is a *promotion tripwire*, not a trim target: if a page naturally exceeds ~18K, split it into sub-topics rather than shrink it.

This is the layer that keeps **LIVE_STATE.md** thin. LIVE_STATE should be a short, keyword-routable index of pointers (`[[wikilinks]]`), capped at ~6K in context; per-project depth belongs in a topic page.

## The three knowledge layers (what goes where)

- **LIVE_STATE.md** (priority 0, ~6K cap): one short stanza per active project — status, focus, blockers, a `[[wikilink]]` to the topic page. Volatile "what's happening right now." NOT the place for architecture dumps or ID lists. **Maintenance note (2026-05-26):** the curated state above the `## Recent Decisions` changelog is ~6K and fits the cap exactly; Recent Decisions is append-only and sits *below* the waterline — only the orchestrator (`liveState: Infinity`) injects it in full. When it starts crowding the orchestrator's budget, prune to ~the last 10 entries rather than relocating the section: older entries already persist as the `[[LRN]]` they cite, so dropping them loses nothing, and a separate file would inject nowhere.
- **Topic page** `vault/topics/<slug>.md` (priority 2, 20K cap): the project's synthesized front page — current state, architecture, gotchas, decisions, follow-ups, pointers. AI-authored. This skill.
- **Raw learnings** `vault/learnings/*.md` (priority 3): atomic LRN/ERR entries, the evidence. The topic page synthesizes and cites these; they stay as fallback.
- (Adjacent: `vault/shared/project-knowledge/<project>.md` is auto-regenerated daily from tagged learnings by `regen-project-knowledge.py` — the "wiki maintainer". Topic pages are higher-priority and broader; link to project-knowledge for depth rather than duplicating it.)

## When to create one (the decision heuristic)

Create a topic page for a project when ANY of these holds — whether the user asks or you judge it yourself:

- The user explicitly says to (e.g. "create a topic page for X", or "start one so I have it from day one"). **Always honor this, even for brand-new/thin projects** — starting early is encouraged.
- The project's LIVE_STATE stanza has grown past ~3–4 lines or carries resource IDs, version history, or architecture detail (that's topic-page content leaking into LIVE_STATE).
- There are ≥~5 vault learnings tagged to the project and a fresh agent would otherwise have to reconstruct the project from scattered entries.
- The project is one you'll return to repeatedly (a product, a job/engagement, a long-running build) rather than a one-off task.

If none hold and the user didn't ask, don't create one — a LIVE_STATE stanza + learnings is enough.

## Creating a page

1. **Pick the slug.** Lowercase kebab-case, matching how the project is referenced (channel/project name): `hey-lexxi`, `mento`, `sigmas-internship`. Don't overwrite an existing page unless `--update`.

2. **Make it routable.** The router resolves a page if the slug matches the **project name** or a **single prompt keyword**, OR via an alias. Prompt keywords are split on non-word chars, so **multi-word, abbreviated, or nickname slugs need an alias.** If the slug is multi-token (e.g. `hey-lexxi`, `sigmas-internship`) or has a nickname, add entries to `TOPIC_SLUG_ALIASES` in `bridges/discord/context-assembler.ts`:
   ```ts
   "hey lexxi": "hey-lexxi", "lexxi": "hey-lexxi",
   ```
   Single-token slugs that equal the project name (e.g. `mento`) resolve on-disk with no alias.

3. **Gather sources** (deterministic-ish): the project's LIVE_STATE stanza, `vault/shared/project-knowledge/<slug>.md` if present, and project-tagged learnings (`grep -l "project: <slug>" vault/learnings/`). List these in `generated_from`.

4. **Verify freshness BEFORE writing current-state claims** — see "## Freshness verification" below. Especially for old/dormant projects, source learnings drift from reality; a synthesis that repeats them is confidently wrong. Check claims against ground truth, mark the unverifiable `_(TBD)_`, and fix stale sources *at the source*.

5. **Author the body** from the verified sources — concise synthesis, not a copy. Cite specific learnings with `[[wikilinks]]`, point to project-knowledge for depth, and mark gaps `_(TBD — …)_` rather than inventing.

6. **Stamp provenance**: `last_synthesized_at` = `date -u +%Y-%m-%dT%H:%M:%SZ`; `last_synthesis_sha` = `git rev-parse HEAD`.

7. **Test**: `cd bridges/discord && HARNESS_ROOT="$PWD/../.." npx tsx --test tests/context-assembler-topic-pages.test.ts`, and add an assertion if you added an alias.

## Updating a page (`--update`)

Re-synthesize the body from current sources, refresh `last_synthesized_at` / `last_synthesis_sha`, but **copy the HUMAN-EDIT zone byte-for-byte** — never edit, summarize, or drop anything between the `HUMAN-EDIT START`/`END` markers.

## Freshness verification

The maintainer (`regen-topic-pages.py`) synthesizes blind and **will repeat a stale source learning as a confident current-state fact** — this happened: a `regression-replay` regen claimed the heartbeats were "never installed" when they had 170 healthy runs. An interactive author has what the maintainer lacks: **ground-truth access**. Use it. This is the exact procedure that produced the verified candidate pages, and the spec for the maintainer's future pre-apply self-heal gate.

1. **List the checkable claims** — anything concrete: a repo/dir exists, a site is live, a referenced file/skill/path exists, current branch/commit/version, a heartbeat is installed/firing, a workflow/deploy ID is current.
2. **Verify each against ground truth — not the model's memory:** `ls` / `git rev-parse` / `git log -1` / `launchctl list` / `curl -sI <url>` / SQLite query / `vercel inspect`. Confirm the artifact actually exists in the claimed state.
3. **Cross-check current-state against the freshest source.** `vault/LIVE_STATE.md` is auto-synced and is the best "right now" signal for status/focus/blockers — prefer it over older learnings when they conflict.
4. **On a mismatch, fix the SOURCE, not just the page.** Mark the stale learning `status: resolved`/`superseded`, add a corrected note + verified date, bump `last-seen`. A page-only fix leaves the stale learning to re-poison the next regen.
5. **Mark the unverifiable explicitly** — `_(TBD — …)_` or hedge "as of <date>". Never assert a dated/past claim in `## Current State`.
6. **Prefer recent + curated sources;** a tight curated `generated_from` beats a tag-dump (the maintainer caps tag-matched learnings at 12 for the same reason).

Risk concentrates on **old/dormant projects** — fresh/active ones (authored days ago, sources still true) rarely need step 4. This is why auto-apply is only safe for fresh-source pages; **old-project pages should be hand-verified (this procedure) or run through the maintainer's freshness gate.**

## Canonical template

```markdown
---
id: TOPIC-<slug>
type: topic
topic: <slug>
parent: null            # or a parent slug if this is a sub-topic (e.g. ai-harness)
sub_topics: []
status: active
last_synthesized_at: <ISO8601 UTC>
last_synthesis_sha: <git HEAD sha>
generated_from:
  - <source path>
---

# <Title>

<!-- HUMAN-EDIT START — optional, rarely used. Anything between these markers is preserved verbatim across AI rewrites; the AI will not touch it. Drop in a North Star, a principle, or a hard constraint you want every agent to internalize. Usually empty. -->
<!-- HUMAN-EDIT END -->

## What this is
## Current State
## Key Architecture
## Known Gotchas
## Active Decisions
## Open Follow-ups
## Related Reading
```

The human-edit zone is **optional and usually empty** — the AI builds the page. It exists only so a human can pin a section (North Star, principle, constraint) that survives every regeneration. Leave the empty marker pair in place even when unused, so the option is discoverable.

## Confidentiality

For private/confidential projects (e.g. an employer engagement), put a local-only banner at the top of the body and never let the page reach `main` or any remote.
