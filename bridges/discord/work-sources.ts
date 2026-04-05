/**
 * Work Sources
 *
 * Integration layer between work-producing systems and the autonomous work queue.
 * Each source has a dedicated enqueue helper with appropriate defaults.
 *
 * Sources:
 *   - heartbeat: notifications that carry actionable work (e.g., code review findings)
 *   - code-review: automated code review results that need agent attention
 *   - session-debrief: knowledge extraction tasks from Claude Code transcripts
 *   - manual: user-enqueued work via Discord command
 *   - self-improvement: vault learnings that need promotion or follow-up
 *   - agent: work enqueued by an agent during task execution
 */

import { enqueue, propose, getProposedWork, parseMetadata, type EnqueueOptions } from "./work-queue.js";

// ─── Source Helpers ─────────────────────────────────────────────────────

/**
 * Enqueue work from a heartbeat notification.
 * Notifications with `"enqueue": true` in their JSONL are routed here.
 */
export function enqueueFromHeartbeat(opts: {
  task: string;
  channelId: string;
  prompt: string;
  agent?: string;
  priority?: number;
  sourceId?: string;
  metadata?: Record<string, any>;
}): string {
  return enqueue({
    source: "heartbeat",
    sourceId: opts.sourceId || `heartbeat:${opts.task}:${Date.now()}`,
    channelId: opts.channelId,
    prompt: opts.prompt,
    agent: opts.agent,
    priority: opts.priority ?? 50,
    metadata: { ...opts.metadata, heartbeatTask: opts.task },
  });
}

/**
 * Enqueue a code review task.
 * Typically triggered by the code-review heartbeat when it finds issues.
 */
export function enqueueCodeReview(opts: {
  channelId: string;
  projectName: string;
  findings: string;
  priority?: number;
}): string {
  const prompt = `[CODE_REVIEW] Review and address the following findings in project "${opts.projectName}":\n\n${opts.findings}\n\nFor each finding: analyze severity, propose a fix, and implement if the fix is safe and well-scoped. Skip any finding that requires user input or could break existing functionality.`;

  return enqueue({
    source: "code-review",
    sourceId: `review:${opts.projectName}:${new Date().toISOString().slice(0, 10)}`,
    channelId: opts.channelId,
    prompt,
    agent: "builder",
    priority: opts.priority ?? 40,
    metadata: { projectName: opts.projectName },
  });
}

/**
 * Enqueue a session debrief extraction task.
 * Triggered by session-debrief heartbeat when there are unprocessed transcripts.
 */
export function enqueueSessionDebrief(opts: {
  channelId: string;
  transcriptPaths: string[];
  priority?: number;
}): string {
  const pathList = opts.transcriptPaths.map(p => `- ${p}`).join("\n");
  const prompt = `[SESSION_DEBRIEF] Extract learnings from the following Claude Code transcripts and write vault entries:\n\n${pathList}\n\nFor each transcript: identify bugs debugged, architecture decisions, gotchas discovered, and project context. Write vault entries using vault_write for significant findings.`;

  return enqueue({
    source: "session-debrief",
    sourceId: `debrief:${Date.now()}`,
    channelId: opts.channelId,
    prompt,
    agent: "researcher",
    priority: opts.priority ?? 30,
    metadata: { transcriptCount: opts.transcriptPaths.length },
  });
}

/**
 * Enqueue work manually from a Discord command.
 */
export function enqueueManual(opts: {
  channelId: string;
  prompt: string;
  agent?: string;
  priority?: number;
}): string {
  return enqueue({
    source: "manual",
    channelId: opts.channelId,
    prompt: opts.prompt,
    agent: opts.agent,
    priority: opts.priority ?? 70, // Manual work is higher priority
  });
}

/**
 * Enqueue self-improvement work (vault maintenance, learning follow-up).
 */
export function enqueueSelfImprovement(opts: {
  channelId: string;
  prompt: string;
  sourceId?: string;
  priority?: number;
}): string {
  return enqueue({
    source: "self-improvement",
    sourceId: opts.sourceId,
    channelId: opts.channelId,
    prompt: opts.prompt,
    agent: "researcher",
    priority: opts.priority ?? 20,
    maxAttempts: 1, // Don't retry self-improvement tasks
  });
}

/**
 * Enqueue work from an agent (agent-initiated follow-up work).
 */
export function enqueueFromAgent(opts: {
  channelId: string;
  prompt: string;
  agent?: string;
  sourceAgent: string;
  priority?: number;
  dependsOn?: string;
}): string {
  return enqueue({
    source: "agent",
    sourceId: `agent:${opts.sourceAgent}:${Date.now()}`,
    channelId: opts.channelId,
    prompt: opts.prompt,
    agent: opts.agent,
    priority: opts.priority ?? 50,
    dependsOn: opts.dependsOn,
    metadata: { sourceAgent: opts.sourceAgent },
  });
}

// ─── Ideation ───────────────────────────────────────────────────────────

/**
 * The ideation prompt sent to the researcher agent.
 * It searches the internet and vault, then outputs structured JSON proposals.
 */
const IDEATION_PROMPT = `You are an autonomous ideation agent. Your job is to propose 1-3 concrete, buildable project ideas that would be valuable for Anderson's portfolio or could generate revenue.

**Research Phase:**
1. Use WebSearch to find trending developer tools, SaaS ideas, viral micro-apps, and underserved niches
2. Use vault_search to understand Anderson's existing skills, projects, and tech stack (TypeScript, Next.js, Vercel, Supabase, Discord bots, AI agents)
3. Cross-reference trends with skills to find high-signal opportunities

**Evaluation Criteria:**
- Buildable in 1-5 days of focused agent work
- Deployable on Vercel + Supabase (free or paid tier)
- Either visually impressive (portfolio) OR monetizable (revenue)
- Not a clone of Anderson's existing projects
- Uses modern stack (TypeScript, Next.js App Router, Tailwind, AI APIs)

**Output Format:**
You MUST output ONLY a JSON array (no markdown, no explanation). Each element:
\`\`\`json
[
  {
    "title": "Short catchy name",
    "category": "portfolio" | "revenue",
    "rationale": "Why this is worth building — market signal, trend, gap",
    "prompt": "Detailed build instructions the builder agent can follow. Include: tech stack, key features (MVP only), deployment target, and what 'done' looks like.",
    "agent": "builder",
    "priority": 50,
    "effort": "1-2 days" | "3-5 days"
  }
]
\`\`\`

Be specific and opinionated. No generic "todo app" ideas. Think: what would make someone say "that's cool" on Twitter or pay $5/month for.`;

/** Max proposals to keep in proposed state at any time */
const MAX_PROPOSED = 5;

/**
 * Run the ideation cycle. Enqueues a researcher task that generates proposals.
 * The researcher outputs JSON which we parse into proposed work items.
 */
export function enqueueIdeation(opts: {
  channelId: string;
}): string | null {
  // Don't generate more ideas if we already have enough proposals waiting
  const existing = getProposedWork();
  if (existing.length >= MAX_PROPOSED) {
    console.log(`[IDEATION] Skipping — already ${existing.length} proposals awaiting review`);
    return null;
  }

  return enqueue({
    source: "ideation-gen",
    sourceId: `ideation-gen:${new Date().toISOString().slice(0, 10)}`,
    channelId: opts.channelId,
    prompt: IDEATION_PROMPT,
    agent: "researcher",
    priority: 25, // Low priority — background work
    maxAttempts: 1,
    metadata: { type: "ideation-generation" },
  });
}

/**
 * Parse ideation output from the researcher and create proposals.
 * Called by the task output handler when an ideation-gen task completes.
 *
 * Handles multiple LLM output formats:
 * - Pure JSON array
 * - JSON wrapped in ```json ... ``` code blocks
 * - JSON mixed with explanation text
 * - Multiple JSON objects (one per idea, not wrapped in array)
 */
export function processIdeationOutput(
  response: string,
  channelId: string
): string[] {
  const ids: string[] = [];

  if (!response || response.trim().length === 0) {
    console.error(`[IDEATION] Empty response — no output to parse`);
    notifyIdeationFailure(channelId, "Empty response from researcher agent");
    return ids;
  }

  try {
    let ideas: any[] | null = null;

    // Strategy 1: Extract JSON from ```json ... ``` code block
    const codeBlockMatch = response.match(/```(?:json)?\s*(\[[\s\S]*?\])\s*```/);
    if (codeBlockMatch) {
      try {
        ideas = JSON.parse(codeBlockMatch[1]);
      } catch { /* try next strategy */ }
    }

    // Strategy 2: Find the outermost JSON array in the response
    if (!ideas) {
      const arrayMatch = response.match(/\[[\s\S]*\]/);
      if (arrayMatch) {
        try {
          ideas = JSON.parse(arrayMatch[0]);
        } catch { /* try next strategy */ }
      }
    }

    // Strategy 3: Find individual JSON objects with title+prompt fields
    if (!ideas) {
      const objectMatches = [...response.matchAll(/\{[^{}]*"title"\s*:\s*"[^"]+?"[^{}]*"prompt"\s*:\s*"[^"]*?"[^{}]*\}/g)];
      if (objectMatches.length > 0) {
        ideas = [];
        for (const m of objectMatches.slice(0, 3)) {
          try {
            ideas.push(JSON.parse(m[0]));
          } catch { /* skip malformed objects */ }
        }
      }
    }

    if (!ideas || !Array.isArray(ideas) || ideas.length === 0) {
      console.error(`[IDEATION] Could not extract JSON ideas from response (${response.length} chars). First 500 chars: ${response.slice(0, 500)}`);
      notifyIdeationFailure(channelId, `Could not parse JSON from researcher output (${response.length} chars)`);
      return ids;
    }

    for (const idea of ideas.slice(0, 3)) {
      if (!idea.title || !idea.prompt) {
        console.warn(`[IDEATION] Skipping idea missing title or prompt: ${JSON.stringify(idea).slice(0, 100)}`);
        continue;
      }

      const id = propose({
        channelId,
        prompt: idea.prompt,
        agent: idea.agent || "builder",
        priority: idea.priority || 50,
        title: idea.title,
        rationale: idea.rationale || "No rationale provided",
        estimatedEffort: idea.effort,
        category: idea.category || "portfolio",
        sourceId: `idea:${idea.title.toLowerCase().replace(/\s+/g, "-").slice(0, 40)}`,
      });
      ids.push(id);
    }

    console.log(`[IDEATION] Created ${ids.length} proposals from ideation output`);
    if (ids.length === 0) {
      notifyIdeationFailure(channelId, "Parsed JSON but no valid ideas (missing title or prompt fields)");
    }
  } catch (err: any) {
    console.error(`[IDEATION] Failed to parse ideation output: ${err.message}. First 500 chars: ${response.slice(0, 500)}`);
    notifyIdeationFailure(channelId, `Parse error: ${err.message}`);
  }

  return ids;
}

/** Notify Discord when ideation fails so failures aren't silent */
function notifyIdeationFailure(channelId: string, reason: string): void {
  try {
    const fs = require("fs");
    const path = require("path");
    const harnessRoot = process.env.HARNESS_ROOT || path.resolve(__dirname, "../..");
    const notifyFile = path.join(harnessRoot, "pending-notifications.jsonl");
    fs.appendFileSync(notifyFile, JSON.stringify({
      channel: "agent-stream",
      message: `[Ideation] Failed to generate proposals: ${reason}`,
    }) + "\n");
  } catch { /* best effort */ }
}

// ─── Continuous Project Iteration ────────────────────────────────────────

/**
 * Mento project iteration (every 3-4h).
 * Works on a dev branch, commits and pushes, NEVER touches main.
 * The builder agent reads code-review findings, vault knowledge, and project
 * state to decide what to work on next.
 */
const MENTO_ITERATION_PROMPT = `You are autonomously iterating on the Mento mentorship platform.

**CRITICAL SAFETY RULES:**
- You are working on a branch called \`harness/auto-dev\`. NEVER push to main. NEVER merge to main.
- Before starting, run: \`git checkout harness/auto-dev 2>/dev/null || git checkout -b harness/auto-dev\`
- After making changes, commit with a descriptive message and push: \`git push origin harness/auto-dev\`
- If the branch is behind main, rebase: \`git rebase main\` (if conflicts, abort and skip this cycle)

**Project Context:**
- Path: ~/Desktop/Seniorproject/mento
- Stack: Next.js 15, React 19, MUI v7, Prisma ORM, PostgreSQL, TypeScript
- Repo: tingtingch/mento
- Your role: Anderson handles RAG, infra, security

**What to Work On (pick ONE per iteration, prioritize top to bottom):**
1. Fix any lint/type errors (run \`npx tsc --noEmit\` first)
2. Address code-review findings (check vault for recent findings)
3. Improve test coverage for existing features
4. Refactor or clean up code that's obviously messy
5. Add small, self-contained improvements (better error handling, loading states, accessibility)
6. Improve documentation (API docs, component docs)

**Rules:**
- Make small, focused commits. Don't refactor the entire codebase at once.
- Run the build/lint check before committing to make sure nothing is broken.
- If you're unsure about a change, skip it. Better to do nothing than break the project.
- Write a brief summary of what you did at the end of your response.`;

export function enqueueMentoIteration(channelId: string): string {
  return enqueue({
    source: "project-iteration",
    sourceId: `mento-iter:${new Date().toISOString().slice(0, 13)}`, // Dedup by hour
    channelId,
    prompt: MENTO_ITERATION_PROMPT,
    agent: "builder",
    priority: 35,
    metadata: { project: "mento", iterationType: "continuous" },
    maxAttempts: 1, // Don't retry — next cycle will pick up
  });
}

/**
 * Lead-gen pipeline iteration (every 1h).
 * Runs the pipeline, iterates on quality, analyzes results.
 * MUST NOT use Brightdata or any paid scraping tools without explicit approval.
 */
const LEAD_GEN_ITERATION_PROMPT = `You are autonomously iterating on the lead generation pipeline.

**CRITICAL SAFETY RULES:**
- NEVER use Brightdata, mcp__brightdata__*, or any tool that costs money. Use only free tools.
- NEVER run commands that could send emails, make API calls to paid services, or incur costs.
- You CAN use: file reads/writes, git, Python scripts, free web searches (WebSearch), free web fetches (WebFetch).

**Project Context:**
- Path: ~/Desktop/lead_gen_pipeline
- Repo: AndersonsRepo/lead-gen-pipeline
- Purpose: Automated lead generation and qualification for service businesses

**What to Work On (pick ONE per iteration, prioritize top to bottom):**
1. Analyze recent pipeline output — check data quality, find patterns in successful leads
2. Improve lead scoring/qualification logic based on what's working
3. Fix any bugs or errors in the pipeline scripts
4. Add new niches or cities to the rotation (research which are underserved)
5. Improve output formatting and reporting
6. Optimize pipeline performance (faster processing, better dedup)
7. Research and document new lead sources that could be integrated (free ones only)

**Rules:**
- Commit changes with descriptive messages and push to main (this is your repo).
- Run tests/checks before committing.
- Write a brief summary of what you did at the end.
- If you need to scrape anything, use only free methods (WebFetch with public URLs).`;

export function enqueueLeadGenIteration(channelId: string): string {
  return enqueue({
    source: "project-iteration",
    sourceId: `leadgen-iter:${new Date().toISOString().slice(0, 13)}`, // Dedup by hour
    channelId,
    prompt: LEAD_GEN_ITERATION_PROMPT,
    agent: "builder",
    priority: 40,
    metadata: { project: "lead-gen", iterationType: "continuous" },
    maxAttempts: 1,
  });
}

// ─── AI Hackathon Iteration (per-project) ────────────────────────────────

const AYTM_ITERATION_PROMPT = `You are autonomously iterating on the Aytm x Neo Smart Living hackathon submission.

**Project Context:**
- Path: ~/Desktop/ai-hackathon/aytm-pipeline/ (Next.js + TypeScript + Supabase)
- Deployed: aytm-pipeline.vercel.app
- Hackathon plan: ~/Desktop/ai-hackathon/HACKATHON-PLAN.md (benchmark data, phases, success metrics)
- Execution plan: ~/Desktop/ai-hackathon/EXECUTION-PLAN.md
- Repo: AndersonsRepo/aytm-market-research
- Event date: April 16, 2026 — 13 DAYS AWAY

**Challenge: Aytm x Neo Smart Living ($2K prize)**
Simulated market research using 3-model triangulation (GPT + Gemini + Claude via OpenRouter).
6 stages already implemented: Client Discovery → Consumer Interviews → Survey Design → Quant Simulation → STAMP Analysis → Validation Report.
Real benchmark data (N=600 US homeowners) hardcoded for comparison.
Stats: Mann-Whitney U, Kruskal-Wallis H, Krippendorff's alpha, KS test, bootstrap CI.

**What to Work On (priority order — read HACKATHON-PLAN.md for details):**
1. **Persona alignment** — Filter to homeowners only, add regional quotas (NE 18%, MW 21%, South 37%, West 24%), 50/50 gender, outdoor recreation diversity
2. **Anti-bias codebook prompts** — STAMP structured prompts per question. Key: storage must rank #1 (not home office), price resistance mean must be near 2.34
3. **Benchmark overlay UI** — Side-by-side bar charts: real vs synthetic for 5 benchmark questions
4. **Disagreement analysis** — Where GPT/Gemini/Claude diverge and why, heatmap visualization
5. **Methodology page** — STAMP explanation, Dr. Lin citation, inter-LLM reliability badges
6. **Executive summary** — Auto-generated from pipeline output with key insight callouts
7. **Deliverables** — Growth strategy, responsible AI statement, measurement plan

**Success Metrics:**
- 5 benchmark questions within ±5pp of real data
- Krippendorff's alpha ≥ 0.68
- Storage correctly ranked as #1 use case
- Price resistance mean within ±0.3 of 2.34

**Rules:**
- Commit and push to main (Vercel auto-deploys).
- Cost awareness — OpenRouter API costs real money. Cache pipeline results, don't re-run unnecessarily.
- Write a brief summary of what you did at the end.`;

const IA_WEST_ITERATION_PROMPT = `You are autonomously iterating on the IA West Smart Match hackathon submission.

**Project Context:**
- Path: ~/Desktop/ai-hackathon/ia-west-smart-match/ (Python + Streamlit)
- Execution plan: ~/Desktop/ai-hackathon/EXECUTION-PLAN.md
- Repo: AndersonsRepo/ia-west-smart-match
- Event date: April 16, 2026 — 13 DAYS AWAY

**Challenge: IA West Smart Match ($2K prize)**
AI-powered CRM matching 18 IA West board members to 50 university engagement opportunities at CPP.
Existing: Streamlit app with 7 tabs, 6-factor weighted matching (TF-IDF cosine similarity), 900 scored matches.
Has Supabase persistence option and passing tests.

**What to Work On (priority order):**
1. **LLM match explanations** — For each top match, generate natural language WHY this speaker fits this event
2. **Smart scheduling** — Cross-reference speaker availability with event dates, flag conflicts
3. **Match confidence scoring** — Beyond cosine similarity, add LLM-assessed quality score
4. **Interactive explorer** — Click speaker → top 10 events with explanations. Click event → top 10 speakers
5. **Dashboard metrics** — Coverage %, unmatched speakers/events, quality distribution
6. **Export workflow** — Generate email templates, meeting agendas, CRM import files
7. **Deploy** — Get a live demo URL (Streamlit Cloud or alternative)
8. **Deliverables** — Responsible AI note, growth strategy

**Rules:**
- Commit and push to main.
- Cost awareness — if using LLM for explanations, cache results.
- Write a brief summary of what you did at the end.`;

export function enqueueAytmIteration(channelId: string): string {
  return enqueue({
    source: "project-iteration",
    sourceId: `aytm-iter:${new Date().toISOString().slice(0, 13)}`,
    channelId,
    prompt: AYTM_ITERATION_PROMPT,
    agent: "builder",
    priority: 75, // High — hackathon deadline April 16
    metadata: { project: "aytm-market-research", iterationType: "continuous" },
    maxAttempts: 1,
  });
}

export function enqueueIaWestIteration(channelId: string): string {
  return enqueue({
    source: "project-iteration",
    sourceId: `iawest-iter:${new Date().toISOString().slice(0, 13)}`,
    channelId,
    prompt: IA_WEST_ITERATION_PROMPT,
    agent: "builder",
    priority: 65, // High — hackathon deadline April 16 (lower than AYTM since it's secondary)
    metadata: { project: "ia-west-smart-match", iterationType: "continuous" },
    maxAttempts: 1,
  });
}

// ─── Lattice Parallel Iteration ──────────────────────────────────────────

/**
 * Lattice parallel creative iteration.
 * Spawns 4 builder agents simultaneously via tmux + git worktrees.
 * Each builder works on a different creative feature for the generative art site.
 *
 * The 4 feature tracks rotate through a set of creative directions.
 * Each iteration picks 4 non-overlapping tasks.
 */
const LATTICE_FEATURE_POOL = [
  {
    label: "builder-1",
    title: "New Generator Engine",
    task: `Add a new generative art engine to src/automata.ts (or a new file). Ideas: reaction-diffusion, Voronoi tessellation, flow fields, fractal flames, strange attractors. Build the engine AND create a docs/ page that showcases it interactively. Make it beautiful. Follow CREATIVE-VISION.md principles.`,
  },
  {
    label: "builder-2",
    title: "Interactive Visualization",
    task: `Create a new interactive page in docs/ that lets users explore the generative art. Think: parameter sliders, real-time rendering, mouse interaction, audio reactivity. Use Canvas 2D or WebGL (Three.js CDN is OK). Keep the dark aesthetic (bg #0a0a0f, accent #7c6fe0).`,
  },
  {
    label: "builder-3",
    title: "Evolution & Gallery Enhancement",
    task: `Improve the evolution system in src/evolve.ts — better scoring functions, new mutation strategies, or a richer genome representation. Then enhance docs/gallery.html or docs/origin.html to better showcase the evolutionary journey. Make the data visualization compelling.`,
  },
  {
    label: "builder-4",
    title: "Site Polish & New Page",
    task: `Read CREATIVE-LOG.md and the existing docs/ pages. Find gaps — missing pages, broken links, rough UI. Fix what's broken, then build one new creative page that adds something the site is missing. Ideas: an about/process page, a live evolution dashboard, a sound-reactive piece, a cellular automata playground.`,
  },
  {
    label: "builder-1",
    title: "L-System Expansion",
    task: `Expand the L-system engine in src/automata.ts with new production rules, stochastic grammars, or parametric L-systems. Create a docs/ page that renders beautiful botanical/fractal L-system art with user-adjustable parameters.`,
  },
  {
    label: "builder-2",
    title: "Color & Palette System",
    task: `Build a sophisticated color/palette system — perceptually uniform gradients, palette extraction from Hall of Fame pieces, color harmony rules. Integrate it into the rendering pipeline and create a docs/ page showcasing palette exploration.`,
  },
  {
    label: "builder-3",
    title: "Performance & Architecture",
    task: `Profile the evolution and rendering pipeline. Optimize hot paths — WebWorkers for generation, requestAnimationFrame for rendering, efficient data structures. Measure before/after. Update any docs that reference performance.`,
  },
  {
    label: "builder-4",
    title: "Generative Music/Sound",
    task: `Add a sound dimension — sonify the generative art using Web Audio API. Map cellular automata states to tones, L-system growth to melodies, or evolution fitness to ambient soundscapes. Create an immersive docs/ page.`,
  },
];

/** Track which features were used last so we rotate */
let latticeFeatureOffset = 0;

/**
 * Build a ParallelDirective for 4 lattice builders.
 * Returns the directive + a function to spawn it.
 */
export function buildLatticeDirective(): {
  agents: string[];
  tasks: Map<string, string>;
} {
  // Pick 4 features, rotating through the pool
  const features = [];
  for (let i = 0; i < 4; i++) {
    features.push(LATTICE_FEATURE_POOL[(latticeFeatureOffset + i) % LATTICE_FEATURE_POOL.length]);
  }
  latticeFeatureOffset = (latticeFeatureOffset + 4) % LATTICE_FEATURE_POOL.length;

  const preamble = `You are working on Lattice, a self-evolving generative art system.

**CRITICAL RULES:**
- Project path: $HARNESS_ROOT/projects/lattice (the worktree will be set as your working directory)
- Read CREATIVE-VISION.md and CREATIVE-LOG.md first
- Static HTML/CSS/JS only in docs/, no build step, no external deps (CDNs OK)
- Dark aesthetic: bg #0a0a0f, accent #7c6fe0, green #4ade80
- Don't modify gallery.json (auto-generated by evolve.ts)
- Keep pages under 500KB
- Commit your changes with a descriptive message (the worktree will be merged automatically)
- Update CREATIVE-LOG.md with what you built

**YOUR SPECIFIC TASK:**
`;

  const agents: string[] = [];
  const tasks = new Map<string, string>();

  for (const feature of features) {
    agents.push(feature.label);
    tasks.set(feature.label, preamble + feature.task);
  }

  return { agents, tasks };
}

/**
 * Enqueue a lattice parallel iteration into the work queue.
 * The actual parallel spawn happens when the dispatcher picks it up —
 * the work item's prompt tells the orchestrator to spawn the parallel group.
 */
export function enqueueLatticeIteration(channelId: string): string {
  return enqueue({
    source: "project-iteration",
    sourceId: `lattice-parallel:${new Date().toISOString().slice(0, 13)}`,
    channelId,
    prompt: "[LATTICE_PARALLEL_SPAWN]", // Marker — handled specially by dispatch callback
    agent: "builder",
    priority: 45,
    metadata: { project: "lattice", iterationType: "parallel", parallelCount: 4 },
    maxAttempts: 1,
  });
}

// ─── Notification Integration ───────────────────────────────────────────

/**
 * Check a notification line for work-queue directives.
 * Notifications with `"enqueue": true` are routed to the work queue
 * instead of (or in addition to) being posted to Discord.
 *
 * Returns the work item ID if enqueued, null otherwise.
 */
export function checkNotificationForWork(
  notif: {
    task?: string;
    channel?: string;
    summary?: string;
    enqueue?: boolean;
    work_prompt?: string;
    work_agent?: string;
    work_priority?: number;
    [key: string]: any;
  },
  channelId: string
): string | null {
  if (!notif.enqueue) return null;

  const prompt = notif.work_prompt || notif.summary || "No description";
  const task = notif.task || "unknown";

  return enqueueFromHeartbeat({
    task,
    channelId,
    prompt,
    agent: notif.work_agent,
    priority: notif.work_priority,
    metadata: { originalNotification: task },
  });
}
