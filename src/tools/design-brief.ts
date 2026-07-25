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

export interface DesignArchetype {
  /** Stable slug used by callers and tests. */
  id: string;
  /** Human-readable name shown in the injected brief header. */
  name: string;
  /** Keyword concepts — one matched regex = one point when scoring a prompt. */
  matchers: RegExp[];
  /** One-line visual attitude. */
  style: string;
  /** EXACT, committed token block — palette + type scale + radius/shadow/spacing. */
  tokens: string;
  /** Layout & content hierarchy. */
  layout: string;
}

export interface DesignBrief {
  archetypeId: string;
  archetypeName: string;
  /** Ready-to-inject prompt text combining the archetype's exact direction. */
  brief: string;
}

/** Compose an archetype's exact tokens into an injectable, mandatory brief. */
function renderBrief(a: DesignArchetype): string {
  return [
    `DESIGN SYSTEM — ${a.name}. Implement these EXACT values; do not substitute your own colors, fonts, or sizes:`,
    a.tokens,
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
