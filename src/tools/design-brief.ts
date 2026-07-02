/**
 * Design brief — turns a free-text app-build request into a compact,
 * ready-to-inject prompt fragment that steers VISUAL design toward a coherent
 * archetype (SaaS, analytics, storefront, fintech, …) plus a universal set of
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
 * Palette guidance names MOODS, not brand rules; where a hex appears it is an
 * illustrative example the builder may replace, never a mandate.
 */

/**
 * Universal constraints — spliced into every build regardless of archetype.
 * Grounded in general UX/accessibility practice (WCAG contrast, motion
 * restraint, keyboard access), not any specific product's house rules. Kept
 * tight and imperative so it reads as buildable rules, not an essay.
 */
export const DESIGN_ANTI_PATTERNS = [
  "UNIVERSAL DESIGN RULES — apply to every build:",
  "• ICONS: use crisp inline SVG icons from one consistent stroke/line set; never use emoji as UI icons. Give each icon an accessible label (aria-label or adjacent text).",
  "• NO DEFAULT GRADIENT IDENTITY: do not reach for a generic purple→pink gradient as the brand. Derive color from the product's actual mood; a flat, deliberate palette beats a decorative gradient.",
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
  /** Overall visual attitude. */
  style: string;
  /** Palette MOOD (moods, not a mandated brand; example hexes are illustrative). */
  palette: string;
  /** Typography mood. */
  typography: string;
  /** Motion / effect character within the universal restraint rules. */
  motion: string;
  /** Layout & content hierarchy. */
  layout: string;
}

export interface DesignBrief {
  archetypeId: string;
  archetypeName: string;
  /** Ready-to-inject prompt text combining the archetype's direction. */
  brief: string;
}

/**
 * Fallback for prompts that match nothing — a clean, contemporary web app.
 * Never a throw: selectDesignBrief always returns a usable brief.
 */
const NEUTRAL_ARCHETYPE: DesignArchetype = {
  id: "modern-web-app",
  name: "Modern Web App",
  matchers: [],
  style: "Clean, contemporary, content-first. Confident whitespace and a clear visual center of gravity; polish through restraint rather than ornament.",
  palette: "One neutral base (off-white or near-black surfaces) plus a single saturated accent used sparingly for primary actions. Example accent: #2563eb. Avoid decorative gradients.",
  typography: "One modern sans for UI and headings; a comfortable reading size (16px+ body) with a clear type scale between headings and body.",
  motion: "Subtle: gentle fades and short position shifts on load and interaction, well inside the 150–300ms window.",
  layout: "Header → primary content → supporting sections → footer. Card or list groupings with generous gutters; a single clear primary action per view.",
};

/**
 * Archetype table — ordered by declaration for tie-breaking (see
 * selectDesignBrief). Original directions grounded in general design practice;
 * none copied from any third-party design source.
 */
const ARCHETYPES: DesignArchetype[] = [
  {
    id: "fintech",
    name: "Fintech & Trust",
    matchers: [
      /\b(fintech|finance|financial|banking|bank)\b/i,
      /\b(payments?|payroll|wallet|billing|invoic\w*)\b/i,
      /\b(trading|trader|traders|invest\w*|brokerage|broker|stocks?|equit(?:y|ies)|hedge fund|crypto|defi|ledger|budget\w*|expense)\b/i,
    ],
    style: "Precise, calm, and trustworthy — accuracy communicated through alignment and generous spacing rather than decoration. Numbers are first-class citizens.",
    palette: "Deep, credible tones — navy or slate anchoring, with a disciplined green/red reserved strictly for gain/loss semantics (never decoration). Example anchor: #0f172a. No playful gradients.",
    typography: "A sans with clear numerals; use tabular/monospaced figures for money and metrics so columns align. Strong numeric hierarchy.",
    motion: "Minimal and reassuring — value updates ease in, no bounce or flourish. Stillness signals reliability.",
    layout: "Key figures and balances up top, then charts, then detailed tables. Dense but legible; clear separation between at-a-glance and drill-down zones.",
  },
  {
    id: "analytics-dashboard",
    name: "Data & Analytics Dashboard",
    matchers: [
      /\b(analytics|metrics?|kpis?|reporting|reports?|insights?|telemetry|monitoring)\b/i,
      /\b(dashboards?|admin panel|control panel)\b/i,
      /\b(charts?|graphs?|data ?viz|visuali[sz]ations?|time ?series)\b/i,
    ],
    style: "Information-dense but scannable — the UI recedes so the data reads. Every pixel earns its place; chrome is quiet.",
    palette: "Neutral canvas with a small, accessible categorical set for series; sequential ramps for magnitude. One accent for interactive state. Example accent: #0ea5e9.",
    typography: "Compact, legible sans with tabular numerals for grids; a tight scale so many values fit without shouting.",
    motion: "Chart transitions animate value changes only; filters and toggles respond instantly with a short highlight.",
    layout: "Filter/toolbar rail, KPI summary row, then a responsive grid of charts and tables. Most-important metric top-left following reading order.",
  },
  {
    id: "ecommerce",
    name: "E-commerce Storefront",
    matchers: [
      /\b(e-?commerce|online store|storefront|shop(?:ping)?|marketplace|retail|boutique|dropship\w*)\b/i,
      /\b(cart|checkout|catalog(?:ue)?|products?|inventory|orders?|sku)\b/i,
    ],
    style: "Product-forward and inviting — imagery leads, the path to purchase is obvious and frictionless. Merchandising over cleverness.",
    palette: "Neutral surfaces so product photography pops, plus one high-contrast action color for add-to-cart and buy CTAs. Example CTA: #16a34a.",
    typography: "Approachable sans; prominent, unambiguous pricing; scannable product titles with clear secondary detail.",
    motion: "Quick, tactile feedback on add-to-cart and gallery swaps; subtle hover lift on product cards. Nothing that delays the buy.",
    layout: "Hero or featured collection → product grid with consistent aspect ratios → clear PDP with gallery, price, and a single dominant CTA. Persistent, obvious cart access.",
  },
  {
    id: "developer-tool",
    name: "Developer Tool",
    matchers: [
      /\b(developer|dev ?tool|devtool\w*|programming|open ?source)\b/i,
      /\b(api|sdk|cli|terminal|ide|debugger|compiler|framework|library|documentation|docs)\b/i,
      /\b(git|deploy\w*|ci\/?cd|devops|pipeline|webhook)\b/i,
    ],
    style: "Efficient, precise, and honest — built for people who read carefully. Density is a feature; code is a first-class element.",
    palette: "Comfortable dark surface by default with a bright accent, or a crisp light theme — offer both. Syntax colors must clear the contrast bar. Example accent: #22d3ee.",
    typography: "A clean sans for prose paired with a real monospace for code and inline identifiers; generous line height in code blocks.",
    motion: "Sparse — copy-to-clipboard confirmations, expandable sections. No decorative motion competing with the content.",
    layout: "Docs-style: left nav, readable center column with runnable code blocks, right-hand on-this-page rail. Copy buttons on every snippet.",
  },
  {
    id: "health-wellness",
    name: "Health & Wellness",
    matchers: [
      /\b(health|wellness|fitness|workout|exercise|gym|nutrition|diet|calorie)\b/i,
      /\b(meditation|mindful\w*|therapy|mental ?health|sleep|habit|self-?care|yoga)\b/i,
      /\b(medical|clinic|patient|doctor|telehealth|symptom)\b/i,
    ],
    style: "Calm, encouraging, and uncluttered — reduces anxiety, celebrates small wins, and never overwhelms. Breathing room is the point.",
    palette: "Soft, restorative tones — muted greens, warm neutrals, gentle blues; low-saturation and easy on the eye. Example: #34d399. Avoid harsh, clinical contrast.",
    typography: "Friendly, rounded-feeling sans; large, calm headings; supportive rather than commanding microcopy.",
    motion: "Slow, soothing transitions and gentle progress reveals; celebratory but understated feedback on completing a goal.",
    layout: "Progress and today's focus first, then guided actions as calm cards, then history. Plenty of whitespace; one clear next step.",
  },
  {
    id: "creative-portfolio",
    name: "Creative Portfolio",
    matchers: [
      /\b(portfolio|showcase|gallery|lookbook)\b/i,
      /\b(photographer|photography|designer|illustrator|artist|creative|freelancer|resume|personal site)\b/i,
      /\b(agency|studio)\b/i,
    ],
    style: "Expressive and editorial — the work is the hero and the UI is a quiet frame around it. Room for a distinct point of view.",
    palette: "Mostly monochrome or a single bold statement color so the work carries the color; let imagery, not chrome, provide vibrancy. Example statement: #f43f5e (use sparingly).",
    typography: "A characterful display face for big statements paired with a neutral sans for captions; dramatic size contrast between the two.",
    motion: "Tasteful reveal-on-scroll and smooth image transitions — one deliberate motion moment per section, never busy.",
    layout: "Full-bleed hero, then an asymmetric or masonry grid of work, generous margins, and a clear contact/about close. Let images breathe.",
  },
  {
    id: "saas-product",
    name: "SaaS Product",
    matchers: [
      /\bsaas\b/i,
      /\b(subscription|onboarding|workspace|multi-?tenant|b2b)\b/i,
      /\b(crm|project management|task manager|team collaboration|productivity|admin dashboard)\b/i,
    ],
    style: "Professional, structured, and confidence-inspiring — approachable enough for first-run, deep enough for daily power use.",
    palette: "A trustworthy brand accent over neutral surfaces; success/warning/error states defined and consistent. Example accent: #6366f1 (as a flat brand color, not a gradient).",
    typography: "Modern, highly legible sans with a disciplined scale; clear labels, helpful empty states, unambiguous button text.",
    motion: "Purposeful — smooth panel and modal transitions, subtle state changes; feedback that confirms an action without theatrics.",
    layout: "Persistent nav (side or top), a focused primary work area, and a clear primary action per screen. Well-designed empty and loading states.",
  },
  {
    id: "marketing-landing",
    name: "Marketing Landing Page",
    matchers: [
      /\b(landing page|landing|marketing|campaign|promo\w*)\b/i,
      /\b(launch|waitlist|coming soon|newsletter|lead ?gen|conversion|signup|sign up)\b/i,
      /\b(startup|product page|hero section)\b/i,
    ],
    style: "Persuasive and momentum-building — a single clear narrative that guides the eye straight to one conversion goal.",
    palette: "Bold, brand-led accent with strong figure/ground contrast for CTAs; confident but not garish. Example CTA: #7c3aed (flat, not a purple→pink gradient).",
    typography: "Big, benefit-led headlines with a strong type scale; short, skimmable body; unmissable CTA labels.",
    motion: "One or two scroll-triggered reveals to build momentum; a single subtle emphasis on the primary CTA. Nothing that distracts from converting.",
    layout: "Hero with headline + sub + primary CTA → proof/benefits → features → testimonial/logos → repeated CTA. One dominant action throughout.",
  },
];

/** Compose an archetype's direction into an injectable prompt fragment. */
function renderBrief(a: DesignArchetype): string {
  return [
    `DESIGN DIRECTION — ${a.name}:`,
    `• Style: ${a.style}`,
    `• Palette & color mood: ${a.palette}`,
    `• Typography: ${a.typography}`,
    `• Motion & effects: ${a.motion}`,
    `• Layout & hierarchy: ${a.layout}`,
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
