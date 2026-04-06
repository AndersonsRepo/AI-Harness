# Live State

> This file is the single source of truth for what's happening right now.
> Agents update it during sessions. The context assembler injects relevant
> sections based on keyword matching and resolves [[wikilinks]] to pull in
> deeper context on demand.
>
> Keep entries short. Use [[wikilinks]] to reference detailed knowledge.
> Sections with no recent updates should be marked stale or removed.

## Active Projects

### Hey Lexxi
- **Status**: Deployed (Vercel) — production
- **Current focus**: Monitoring, stability
- **Blockers**: None known
- **Links**: [[hey-lexxi.md]] [[ERR-hey-lexxi-vercel-limits]]

### Mento
- **Status**: In development — senior project
- **Current focus**: Mentorship platform features
- **Blockers**: Dead letter tasks (builder agent exits, Mar 29-30)
- **Links**: [[mento.md]]

### Lattice
- **Status**: Deployed (Vercel + Supabase) — autonomous evolution
- **Current focus**: Lattice evolution cycles
- **Blockers**: None known
- **Links**: [[lattice.md]]

### Lead Gen Pipeline
- **Status**: Paused — data quality issues
- **Current focus**: B2B pipeline diagnosis
- **Blockers**: 60% contact accuracy, 40% email accuracy
- **Links**: [[lead-gen-pipeline.md]] [[ERR-lead-gen-pipeline-gotchas]]

### AI Harness
- **Status**: Active development
- **Current focus**: Scheduler agent, CI auto-fix, work queue evaluation loop
- **Recent changes**: Selective 1M context, heartbeat management channels
- **Links**: [[ai-harness.md]]

## Priorities

1. Keep harness running autonomously at max capacity
2. Senior project (Mento) deadlines
3. Portfolio project generation (autonomous work queue)
4. Revenue-generating apps (lead gen pipeline when data quality fixed)

## Infrastructure Health

- **Bot**: Check `bridges/discord/.bot.pid`
- **Heartbeats**: 3 auto-paused (calendar-sync, deploy-monitor, email-monitor), 14 stale
- **Dead letters**: 25 dead queue entries, 3 in dead_letter table
- **OAuth**: Microsoft + LinkedIn tokens — check expiry
- **Links**: [[LRN-heartbeat-auto-pause]] [[LRN-oauth-token-refresh]]

## Courses (Spring 2026)

- **Numerical Methods**: [[numerical-methods/]]
- **Philosophy**: [[philosophy/]]
- **Systems Programming (CS 2600)**: [[systems-programming/]]
- **Computers and Society**: [[comp-society/]]

## Recent Decisions

- Scheduler agent created for dedicated heartbeat management
- CI auto-fix heartbeat polls GitHub Actions, fixes on new branches, prompts user to merge
- Work queue now has evaluate→adjust loop (max 3 iterations)
- Context limits raised for orchestrator (50K) and builder (50K)
- Notification routing defaults changed: heartbeat-status instead of general
