---
name: progress-schematic
description: Draw a one-page schematic of build progress for Dona Dom stakeholders — what stands, what was just added, what it holds up. Use whenever asked to visually summarize a slice, a day, or a week ("show this to stakeholders", "visual summary", "diagram what we built", "something for the client"). Produces a published Artifact, not prose.
---

# Progress schematic

The audience is **looped-in but non-technical**: Dona Dom stakeholders who know what the product is and do not need it explained. They want to see what exists, what is new, and how the pieces connect. Prose-heavy briefs were explicitly rejected — a text page that "explains what we're building" is the failure mode this skill exists to prevent.

## Rules

1. **The drawing is the deliverable.** One inline `<svg>` in a `<figure>`. Word budget for the whole page: ~60 words outside labels. No intro paragraph, no "what we're building" section.
2. **Show relationships, not an inventory.** Boxes alone restate a list. The value is in the connectors: what supports what, what consumes what.
3. **Never invent a dependency.** Every arrow and chip must be true of the actual code. Check `tasks/todo.md` and the source before drawing.
4. **Translate, don't dumb down.** "One number per record", not "UUIDv7 generation". Keep one real technical detail per card (a sample id, the five error words) — it signals substance without requiring explanation.
5. **Facts carry the proof.** End with real numbers from the verify step (tests green, timings). Never round up or estimate.

## Structure (bottom to top = "supports")

Reuse `template.html` and re-label it. The grammar, in order:

- **Header** — eyebrow (`DONA DOM · TENANCY OS · WEEK n`), short title naming the moment, legend of the three states.
- **Top band, dashed grey** — what's next. Each box carries small glyph chips naming which of today's pieces it will consume. This is the dependency graph, and it replaces spaghetti connectors.
- **Bus line** — one horizontal rule with the label plate breaking it, between today's band and the next band. A bus shows many-to-many without crossing lines; use it rather than drawing every edge.
- **Middle band, ochre outline + "ADDED TODAY" tab** — the slice just finished, as three cards: glyph badge, `One <thing>` title, two-line plain-language description, and an inset showing real data.
- **Second bus + "STANDS ON"** — connecting down to the foundation.
- **Bottom band, solid teal** — what was already standing, with day tags.
- **Proof strip** — 2–4 monospace figures above short labels.

Arrows all point **up**; direction is consistent so it never needs a legend.

**When a slice adds something that is not a layer** — a CI gate, a verification step, anything every change must pass rather than stand on — do not force it into a band. Draw it as a full-width strip across the path, with the bands below feeding into it and a single labelled arrow leaving the top (`ONLY A GREEN GATE DEPLOYS`). A perimeter drawn as a layer tells a lie about how it works.

## Visual system

Tokens are defined at the top of `template.html` — copy them wholesale, all three theme blocks (`:root`, the `prefers-color-scheme` guard, and `[data-theme="dark"]`).

- **Palette**: cool grey-green paper, deep teal = standing, ochre = added today, muted dashed grey = next. Teal and ochre are the only hues; everything else is neutral.
- **Type**: IBM Plex Sans Condensed (titles), IBM Plex Sans (descriptions), IBM Plex Mono (annotations, data, eyebrows). Drafting-drawing feel; loaded from Google Fonts, the only host the Artifact CSP allows.
- **Ground**: dot-grid `<pattern>` at 22px.
- **Scale**: `viewBox="0 0 1040 H"`, three column tracks at x = 40 / 367 / 694, each 306 wide.

## Mechanics that bite

- Arrowhead markers point along **+x** in marker space (`points="0,0 10,5 0,10"`, `refX="9" refY="5"`). A polygon drawn pointing up renders rotated 90° under `orient="auto"`.
- No `<style>`, `<script>`, or `<foreignObject>` inside the SVG — put CSS in the page's own `<style>` and target classes.
- Wrap the SVG in `overflow-x: auto` with `min-width: 780px` so small screens scroll instead of shrinking the text to nothing.
- Give the `<svg>` `role="img"` and an `aria-label` stating the whole claim.

## Verify before publishing

The in-app browser cannot open a private artifact (not signed in), so check the markup mechanically: tag balance, that every `url(#id)` resolves, and that no forbidden element is inside the SVG. Then sanity-check text widths against box widths — condensed titles ≈ 8.5px/char at 19px, mono ≈ 6.9px/char at 11.5px.

Publish with `favicon: 📐`. Republish the same file path to keep the link stable.
