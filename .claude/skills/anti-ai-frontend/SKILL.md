---
name: anti-ai-frontend
description: Audit a frontend project against the anti-AI design ruleset — greps for banned patterns (gradient buttons, blob backgrounds, default Tailwind blue, Inter/Roboto display, Lucide-only icons, hardcoded hex, fake testimonials, emoji icons, three-col icon grids, glassmorphism stacks, fade-up-on-scroll, identical card grids). Captures Playwright screenshots if a deployed URL is provided. Outputs a violations report with file:line citations; does not fix anything.
user-invocable: true
argument-hint: "[<path-to-project> | <deployed-url>]   defaults to cwd"
allowed-tools:
  - Read
  - Grep
  - Glob
  - Bash
---

# anti-ai-frontend — Frontend Anti-Generic Audit

Read-only audit of a frontend project against the rules in:
- `prompts/anti-ai-checklist.md` (project-local if present) — SMB-tactical bans
- `prompts/design-rules.md` (project-local if present) — broader playbook
- This skill's `RULES.md` (built-in fallback if the project has no `prompts/`)

The skill **does not modify files**. It produces a violations report.

## When to invoke

- Before shipping any frontend build, especially generator-emitted sites
- After a redesign, to verify no AI tells regressed in
- On any third-party landing page you want to sanity-check ("does this look AI?")

## Workflow

### Phase 1 — Locate the rules

1. If invoked with an argument that is a directory, `cd` there. If it's a URL, treat the project root as cwd.
2. Look for `prompts/anti-ai-checklist.md` + `prompts/design-rules.md` in the project. If present, those are authoritative. If absent, use the built-in `RULES.md` next to this `SKILL.md`.

### Phase 2 — Static grep audit

Run these greps from project root. Each match = candidate violation; cite as `file:line`.

| Rule | Grep pattern (rg syntax) |
|---|---|
| Floating blob backgrounds | `blur-3xl\\|blur-\\[.*xl\\]\\|w-\\[40rem\\]\\|h-\\[40rem\\]` (and inspect for paired `rounded-full`) |
| Gradient buttons | `linear-gradient.*btn\\|bg-gradient-to-.*btn` and `\\.btn-primary\\s*\\{[^}]*linear-gradient` |
| Gradient text | `text-gradient-accent\\|bg-clip-text.*linear-gradient` |
| Glassmorphism overuse | `backdrop-blur\\|backdrop-filter:\\s*blur` (count > 1 per page = violation) |
| Lucide-only icons | `from ['"]lucide-react['"]` (and confirm no other icon import exists in the same project) |
| Emoji as feature icons | grep feature-card files for emoji ranges: `[\\x{1F300}-\\x{1FAFF}]\\|[\\x{2600}-\\x{27BF}]` |
| Default Tailwind blue | `#3B82F6\\|bg-blue-500\\|text-blue-500\\|border-blue-500\\|from-blue-500\\|to-blue-500` |
| Hardcoded hex in components | `style=\\{\\{[^}]*#[0-9A-Fa-f]{3,8}` |
| Inter as display | `fontDisplay:\\s*['"]Inter\\|font-display.*Inter` |
| Space Grotesk | `Space\\s+Grotesk` |
| Cobe globe | `import.*cobe\\|<Cobe\\|require\\(['"]cobe` |
| Magic UI signatures | `magicui\\|animated-beam\\|sparkles\\|meteors` |
| Fade-up carpet bomb | `animate-fade-up\\|whileInView` (count > 1 per page = violation) |
| Carousel testimonials | `Swiper\\|EmblaCarousel\\|<Carousel` + `testimonial` proximity |
| Stock mockup frames | `macbook-mockup\\|iphone-mockup\\|device-frame\\|laptop-mockup` |
| Pure `#000000` BG | `background:\\s*['"]?#000000?['"]?\\|bg-black\\b` (in body/html/hero context) |
| Pure `#FFFFFF` BG | `background:\\s*['"]?#FFF(FFF)?['"]?\\|bg-white\\b` (in body/html/hero context) |
| Center-aligned body text | `text-center` on `<p>` elements > 80 chars |
| Three-col icon-feature grid | look for any section component with `grid-cols-3` + `<Icon` + `<h3` in pattern |

### Phase 3 — Dynamic visual audit (optional, if URL provided)

If the user provided a deployed URL:

```bash
# Use the project's own playwright if installed, otherwise /tmp/site-shots
URL="$1"
mkdir -p /tmp/anti-ai-audit && cd /tmp/anti-ai-audit
[ -d node_modules/playwright ] || (ulimit -f unlimited && npm install playwright --silent && npx playwright install chromium)
cat > shot.mjs <<EOF
import { chromium } from "playwright";
const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const page = await ctx.newPage();
await page.goto("$URL", { waitUntil: "networkidle", timeout: 30000 });
await page.screenshot({ path: "hero.png", fullPage: false });
for (const y of [800, 1800, 2800, 3800]) {
  await page.evaluate(yy => window.scrollTo(0, yy), y);
  await page.waitForTimeout(700);
  await page.screenshot({ path: \`scroll-\${y}.png\`, fullPage: false });
}
await browser.close();
EOF
ulimit -f unlimited && node shot.mjs
```

Then read each PNG with the `Read` tool and check against the 10-item validator in `prompts/anti-ai-checklist.md` (or this skill's `RULES.md`). Specifically:

1. Font count ≥ 2; display face is NOT Inter/Roboto/Helvetica/Space Grotesk
2. Accent color is not a banned gradient
3. No orb / cobe / abstract hero
4. At least 1 asymmetric section
5. At least 1 piece of unmistakably-real specific copy (named owner, license #, neighborhood)
6. No `fade-up-on-scroll` boilerplate (visible motion on > 1 section = fail)
7. No glassmorphism stack > 1 layer
8. Numeric callouts in monospace
9. At least 1 live/dated element
10. Project-local `DESIGN.md` (or `prompts/design-rules.md`) exists and was honored

### Phase 4 — Report

Output a single markdown report with:

```markdown
# Anti-AI Audit — <project name or URL>

## Score
PASS / WARN / FAIL  (FAIL if ≥ 3 of the 10 validator items fail)

## Static violations (N found)
- `path/to/file.tsx:42` — gradient button: `linear-gradient(...)` — replace with solid `var(--color-accent)`
- `path/to/file.tsx:108` — hardcoded hex `#FF6B35` — replace with `var(--color-accent)` token
- ...

## Visual violations (M found, if URL audited)
- hero.png — H1 font appears to be Inter (the #1 AI fingerprint)
- scroll-1800.png — 3-column identical icon grid as first post-hero section
- ...

## Required signals present (≥ 3 needed)
✓ Real compliance metadata (license # found in footer)
✓ Named first-name testimonials
✗ Geographic specifics (no neighborhood references found)
✗ Dated promotions (no specific dates found)
✗ Founder voice + face

## Recommended fixes (top 3 by impact)
1. ...
2. ...
3. ...
```

### Phase 5 — Exit cleanly

Do NOT edit any files. Do NOT propose multi-file patches. The skill produces a report and stops. If the user wants fixes, that's a separate ask.

## Output conventions

- One `file:line` per violation; group by rule.
- Use the project's existing tone in the report (terse, headers + bullets).
- Never assert PASS unless every grep returned 0 + every visual item is clean.
