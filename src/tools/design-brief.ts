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
