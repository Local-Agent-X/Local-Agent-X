/**
 * Design brief — turns a free-text app-build request into a compact,
 * ready-to-inject prompt fragment that steers VISUAL design toward a coherent
 * archetype (SaaS, analytics, storefront, fintech, …), plus a universal set of
 * anti-patterns that apply to EVERY build.
 *
 * Sibling to app-tier.ts and render-builder-prompt.ts: those classify WHAT to
 * build (tier, website-vs-app, backend needs). This classifies how it should
 * LOOK. Keyword classifier in the same shape as looksLikeWebsiteRequest —
 * word-boundary regexes, `/i`, no `/g` (a global flag carries lastIndex state
 * across .test() calls and would flap). Pure and dependency-free: it never
 * touches disk and never throws — an unmatched or empty prompt falls back to a
 * neutral default archetype so the caller always gets a usable brief.
 *
 * Each archetype carries an EXACT, committed token set (design-systems.ts), not
 * mood prose: a full palette, an exact font stack + type scale, and exact
 * radius/shadow/spacing. Vague guidance ("a modern sans", "navy or slate") lets
 * a model with no visual taste fill the gaps with slop; exact tokens give it a
 * real system to implement. The brief is a MANDATE — the builder implements the
 * values, it does not "pick something similar".
 */
import { ARCHETYPES, NEUTRAL_ARCHETYPE } from "./design-systems.js";
import { PALETTES, TOKEN_CSS_NAMES, type PaletteId, type PaletteTokens } from "./design-palettes.js";

/**
 * Universal constraints — spliced into every build regardless of archetype.
 * Grounded in general UX/accessibility practice (WCAG contrast, motion
 * restraint, keyboard access). Kept tight and imperative so it reads as
 * buildable rules, not an essay.
 */
export const DESIGN_ANTI_PATTERNS = [
  "UNIVERSAL DESIGN RULES — apply to every build:",
  "• ICONS: use crisp inline SVG icons from one consistent stroke/line set; never use emoji as UI icons. Give each icon an accessible label (aria-label or adjacent text).",
  "• NO DEFAULT GRADIENT IDENTITY: do not reach for a generic purple→pink gradient as the brand. Use the archetype's exact palette; a flat, deliberate color beats a decorative gradient.",
  "• MOTION RESTRAINT: animate at most 1–2 elements per view — a single focal moment, not everything at once. No autoplaying, looping, or attention-competing motion.",
  "• MICRO-INTERACTIONS: hover/press/focus transitions land in 150–300ms with an ease curve; nothing slower feels laggy, nothing instant feels cheap.",
  "• KEYBOARD FOCUS: every interactive element has a clearly VISIBLE focus state (never `outline: none` without a replacement). Tab order must be logical.",
  "• REDUCED MOTION: honor `@media (prefers-reduced-motion: reduce)` — drop or shorten non-essential animation for users who ask for it.",
  "• CONTRAST: body text and interactive text meet a contrast ratio of at least 4.5:1 against their background (WCAG AA); don't ship low-contrast grey-on-grey.",
  "• CURSOR AFFORDANCE: interactive elements show `cursor: pointer`; non-interactive text does not. The pointer must never lie about what is clickable.",
  "• RESPONSIVE: lay out and test at the common breakpoints ~375 (mobile), ~768 (tablet), ~1024 (small laptop), and ~1440 (desktop); no horizontal scroll or clipped content at any of them.",
  "• TYPEFACE: implement the archetype's named face. Do NOT substitute a default UI sans and do NOT let a bare system-ui stack stand in as the identity — the same safe sans on every site is the single most recognized tell of a machine-made page. When you self-host an open-licensed face, ship its license file alongside the font files.",
  "• NOT THE DEFAULT LAYOUT: a centered hero stacked over three equal feature cards is the shape every generated page takes; do not ship it. Vary the rhythm — an asymmetric split, a full-bleed band, cards of deliberately different sizes, content that starts left instead of centered.",
  "• ELEVATION IS HIERARCHY: do not put the same large radius and the same drop shadow on every surface. Most blocks are flat with a 1px --border; reserve shadow for what genuinely floats above the page (a menu, a modal, one focal card).",
  "• ICONS IN CONTEXT: no grid of icons each sitting in its own rounded-square tile, and no emoji standing in as feature bullets. An icon sits with its label, at text scale.",
  "• BLUR IS NOT A STYLE: no reflexive frosted-glass panels. backdrop-filter belongs on something that genuinely overlays moving content — a sticky header above a scrolling page — not on a resting card.",
  "• REAL COPY: write the actual sentence for the actual product. No filler voice — \"Elevate your…\", \"Seamlessly…\", \"Unlock the power of…\" — and no invented statistics or fake testimonials to fill a section.",
].join("\n");

/**
 * Craft rules — the POSITIVE half of the anti-patterns. The anti-patterns say
 * what not to do; these say concretely what "polished" IS, because "make it
 * look polished, use good colors" (the line this replaces) is too vague to act
 * on — a model with no visual taste of its own reads it as "I already did".
 * These are the execution details that separate a working page from a designed
 * one: depth, a real type ladder, spacing rhythm, alignment, and — the big one
 * a happy-path build skips — every STATE (empty / loading / error /
 * hover-focus-active-disabled). Applied to EVERY build (create AND update),
 * archetype-independent, so it also lifts an update and the neutral fallback.
 * Kept tight and imperative like DESIGN_ANTI_PATTERNS, not an essay; it does not
 * repeat the anti-patterns (icons, contrast, motion, focus visibility live there).
 */
export const DESIGN_CRAFT = [
  "CRAFT — what a polished, designed result concretely means (apply to every build):",
  "• DEPTH: build a layered surface hierarchy with the archetype's shadow/border tokens — page background sits under cards, cards under any popover/menu. Flat, borderless blocks on a same-color background read as unfinished; separate surfaces with a subtle shadow OR a 1px border, not both heavy.",
  "• TYPE LADDER: use the archetype's type scale to make hierarchy obvious at a glance — ONE dominant page title, clearly smaller/lighter section headings, and body/label tiers that differ visibly in BOTH size and weight. If headings and body look nearly the same size, the hierarchy has failed.",
  "• SPACING RHYTHM: commit to one spacing scale (the archetype's base) and use it everywhere — generous, even padding inside cards and around sections; related items grouped tighter than unrelated ones. Cramped or arbitrary, inconsistent gaps are the fastest tell of an unpolished UI.",
  "• ALIGNMENT: align everything to a shared grid and shared edges — labels, values, controls, and card contents line up column-to-column. Ragged, off-by-a-few-pixels alignment looks broken even when nothing is.",
  "• STATES (do not ship only the happy path): design the EMPTY state as a real, intentional view (one short line + the primary action, never a blank void); show a LOADING state (skeletons or a spinner, never a frozen blank); handle ERRORS inline with a plain human message; and give every interactive element distinct HOVER, ACTIVE, FOCUS, and DISABLED styling. A UI that only looks right when it is full of data is not finished.",
  "• FOCAL POINT: give each view one clear center of gravity — the primary action or the key figure is visually dominant (size, weight, or color), and secondary things recede. Avoid a flat field where every element competes for attention.",
  "• COHESION: one radius, one border treatment, one icon set, one control style across the whole app — buttons, inputs, and cards share a single visual language. Mismatched components read as assembled, not designed.",
  "• CONTENT POLISH: use realistic sample content, never 'lorem ipsum' or 'Item 1'; format numbers (thousands separators, currency, aligned decimals); and make sure long strings truncate or wrap cleanly instead of breaking the layout.",
].join("\n");

/**
 * Techniques — the modern CSS a model does not reach for on its own.
 *
 * Separate from CRAFT and the anti-patterns because it answers a third
 * question. CRAFT says what polished looks like; the anti-patterns say what to
 * avoid; this says which mechanism to build it WITH. Left unstated, a model
 * writes the CSS that dominates its training data — four breakpoints, viewport
 * media queries for components, full-width paragraphs, a focus ring that
 * follows the mouse — and the result is dated in a way no amount of palette
 * fixes. Every rule here is a widely-available feature, no polyfill and no
 * fallback needed; anything still uneven across browsers is deliberately left
 * out rather than shipped as progressive enhancement nobody tests.
 *
 * Applied to EVERY build, create and update, archetype-independent.
 */
export const DESIGN_TECHNIQUES = [
  "TECHNIQUES — build the design with these, not with the defaults (apply to every build):",
  "• FLUID, NOT STEPPED: express the page title and section padding as `clamp(<small-screen>, <preferred vw>, <large-screen>)`, where the size the DESIGN SYSTEM states is the large-screen end; body and label sizes stay exactly as given. The layout must hold at every width between 375 and 1440, not only at four of them.",
  "• CONTAINER QUERIES: a component sizes itself to ITS CONTAINER, not the viewport — `container-type: inline-size` on the wrapper, then `@container (min-width: …)` for the component's own breaks. The same card in a sidebar and at full width must both read correctly without knowing where it is. Keep viewport media queries for page-level layout only.",
  "• INTRINSIC GRIDS: lay card grids out with `grid-template-columns: repeat(auto-fit, minmax(<min>, 1fr))` so they reflow with no breakpoint math, and size widths with min()/max()/clamp() instead of fixed pixel columns.",
  "• MEASURE: cap running text at about 65ch. A paragraph spanning a 1440px window is the fastest sign nobody set a line length.",
  "• TEXT WRAPPING: `text-wrap: balance` on headings so the last line isn't a single orphaned word, and `text-wrap: pretty` on body copy. Two declarations, and the typography stops looking accidental.",
  "• FOCUS RING ON :focus-visible: style `:focus-visible`, not `:focus`, so keyboard users get the ring and a mouse click does not leave one behind. Give it `outline-offset` so it sits clear of the control's own edge.",
  "• NATIVE CONTROLS JOIN THE DESIGN: set `accent-color: var(--accent)` so checkboxes, radios and range inputs match the system instead of shipping browser blue. Validate with `:user-invalid`, never `:invalid` — the latter marks a field red before the user has typed anything.",
  "• NO LAYOUT SHIFT: every image and video carries width/height attributes or an `aspect-ratio` plus `object-fit: cover`, so nothing reflows as media loads. Below the fold, add `loading=\"lazy\"` and `decoding=\"async\"`.",
  "• STICKY HEADER OFFSET: if the header is sticky, give anchor targets `scroll-margin-top` equal to its height — otherwise every in-page link lands with its heading hidden underneath.",
  "• STYLE FROM CONTENT WITH :has(): let a parent react to what it contains (`.card:has(img)`, `.field:has(:user-invalid)`) instead of adding a JavaScript class to say the same thing.",
].join("\n");

export interface DesignArchetype {
  /** Stable slug used by callers and tests. */
  id: string;
  /** Human-readable name shown in the injected brief header. */
  name: string;
  /** Keyword concepts — one matched regex = one point when scoring a prompt. */
  matchers: RegExp[];
  /** One-line visual attitude. */
  style: string;
  /** Role-mapped color, both modes. The values live in design-palettes.ts so
   *  the contrast test can measure them; a palette inlined here as prose could
   *  not be checked, which is how the 4.5:1 rule went unverified for so long. */
  palette: PaletteId;
  /** EXACT font stack + type scale with weights and letter-spacing. */
  typography: string;
  /** EXACT radius / shadow / spacing. */
  geometry: string;
  /** Anything true of this archetype alone — a chart series, a token that
   *  behaves unusually here, a layout liberty it is granted. */
  extra?: string;
  /** Layout & content hierarchy. */
  layout: string;
}

export interface DesignBrief {
  archetypeId: string;
  archetypeName: string;
  /** Ready-to-inject prompt text combining the archetype's exact direction. */
  brief: string;
}

/**
 * Render the palette as the CSS the builder should literally write. Emitting
 * `light-dark()` pairs rather than a light palette plus "and add a dark mode"
 * is the whole reason both modes survive: one definition, no second pass to
 * forget, and no way to ship a token that only exists in one theme.
 */
function renderPalette(id: PaletteId): string {
  const tokens = PALETTES[id];
  const names = Object.keys(TOKEN_CSS_NAMES) as (keyof PaletteTokens)[];
  return [
    "Color tokens (EXACT). Put `color-scheme: light dark` on :root and define each token once — every value is a light-dark() pair, so the app ships BOTH themes from one definition:",
    ...names.map((n) => `  ${TOKEN_CSS_NAMES[n]}: light-dark(${tokens[n][0]}, ${tokens[n][1]});`),
    "Token roles — use the one that names the job: --surface-hover is a card under the pointer · --border is a component edge, --border-subtle a row divider · --accent is a FILL (buttons, active nav), never body-text color · --accent-contrast is the text ON --accent and is NOT always white · --success/--warn/--danger are semantic only. Derive any shade you still need with color-mix() against these, never a fresh invented hex.",
  ].join("\n");
}

/** Compose an archetype's exact system into an injectable, mandatory brief. */
function renderBrief(a: DesignArchetype): string {
  return [
    `DESIGN SYSTEM — ${a.name}. Implement these EXACT values; do not substitute your own colors, fonts, or sizes:`,
    renderPalette(a.palette),
    `Typography: ${a.typography}`,
    a.geometry,
    ...(a.extra ? [a.extra] : []),
    `Attitude: ${a.style}`,
    `Layout & hierarchy: ${a.layout}`,
  ].join("\n");
}

/**
 * Keyword-classify a build request to its best-fit archetype and return an
 * injectable brief. Scores each archetype by how many keyword concepts match;
 * the highest score wins, ties broken by declaration order (first wins). An
 * empty or unmatched prompt returns the neutral default. Never throws.
 */
export function selectDesignBrief(promptText: string): DesignBrief {
  const text = typeof promptText === "string" ? promptText : "";
  let best = NEUTRAL_ARCHETYPE;
  let bestScore = 0;
  for (const arch of ARCHETYPES) {
    let score = 0;
    for (const m of arch.matchers) if (m.test(text)) score++;
    if (score > bestScore) {
      bestScore = score;
      best = arch;
    }
  }
  return { archetypeId: best.id, archetypeName: best.name, brief: renderBrief(best) };
}
