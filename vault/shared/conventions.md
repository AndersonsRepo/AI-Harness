---
title: Project Conventions
updated: 2025-03-10
scope: shared
---

# Conventions

## Code
- TypeScript for all new code
- npm as package manager (pnpm is not installed)
- Node.js 22+ (currently 23.11.0)

## Documentation
- Always update documentation alongside code changes
- Lead with answers, skip filler
- Ask before destructive actions (delete, force-push, overwrite)

## Git
- Test between phases before committing
- Commit messages should be descriptive and reference the phase/feature

## Agent Behavior
- Log errors, corrections, and knowledge gaps to `vault/learnings/`
- When a learning recurs 3+ times, promote it to `CLAUDE.md`
- When a reusable workflow is discovered, extract it into a new skill

## Discord Response Rules
- Keep responses concise — you are posting to Discord, not writing documentation
- NEVER paste raw fetched web content, API docs, or full page dumps into responses
- When you fetch a URL, summarize the relevant parts in your own words
- If the user needs the raw content, tell them where to find it (provide the URL)
- Maximum response guideline: ~3000 characters. If you need more, ask if the user wants details
- Code snippets should be short and targeted — not entire API references

## Vault Rules
- Each learning is its own file in `vault/learnings/` with YAML frontmatter
- Use `[[wikilinks]]` for cross-references between entries
- Tags in frontmatter must be lowercase kebab-case arrays
- `pattern-key` must be a unique short kebab-case identifier
- Never delete vault files — mark status as `archived` instead
