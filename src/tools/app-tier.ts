/**
 * App-tier classifier — the honest boundary for build_app.
 *
 * The app-builder is HTML-first: every build seeds an index.html and the loop
 * pushes toward a single static page. That's exactly right for the 99% case
 * (personal dashboards, tools, trackers — runnable in the browser with no
 * backend). It is WRONG, and silently dishonest, for two kinds of request:
 *
 *   - compiled-native — a Rust/Go/C/C++/native program. The model writes real
 *     source but, funneled toward HTML, ships a browser JS reimplementation and
 *     (used to) claim it matches. The honest path is to actually run the
 *     toolchain and show its real output.
 *   - full-stack — an app that needs a real backend / dev server (a framework
 *     with a build step, an API server, a real database). The HTML path fakes
 *     it with hardcoded data in index.html. The honest path is to stand up the
 *     real backend and reach it through a connector.
 *
 * This classifier is the detection half: it decides which of the three tiers a
 * build brief is, so the builder can be instructed (and equipped) to build it
 * for real instead of faking. The hard signals below stay deterministic —
 * predictable, explainable, no fallback-to-fake. The quick-html residue (a
 * real app described in words the keyword lists don't know) gets an LLM
 * second opinion at the build_app call site via classifyAppTierEscalation —
 * ESCALATION-ONLY, so an LLM timeout/outage keeps the regex verdict and can
 * never itself cause the fall-back-to-fake this file exists to kill.
 *
 * Bias: quick-html stays the lane for genuinely trivial single-screen static
 * tools (a calculator, a tracker, a landing page) — instant, can't-fail, no
 * install. Escaping to a real-build tier fires only on HIGH-PRECISION signals:
 * a named framework or backend engine, OR plain-English real-app phrasing a
 * static page can't honestly be (login/signup, multi-page, "web app"). Soft
 * words a plain HTML app legitimately uses — "dashboard", "database", "db",
 * "app" alone — never escape on their own. The asymmetry is deliberate: a real
 * app read as quick-html ships a faked static page (the failure this fixes), but
 * a trivial tool read as frontend-spa pays a real build+verify tax, so the
 * real-app signals stay tight to avoid over-routing the simple case.
 */

import { classifyAppTierEscalation } from "../classifiers/app-tier-classify.js";

export type AppTier = "quick-html" | "full-stack" | "frontend-spa" | "compiled-native";

/**
 * A materially-ambiguous brief the escalation LLM declined to tier — the target
 * might not be software ("a mega computer") or the plausible builds diverge
 * enough that guessing wastes a real build. build_app surfaces the question
 * instead of blind-building. Distinct from merely-vague briefs (those get a
 * tier and build). See classifiers/app-tier-classify.ts.
 */
export interface AppTierClarify {
  kind: "clarify";
  question: string;
  /** 2-4 concrete interpretations for the user to pick from. */
  options: string[];
}

// Compiled / native languages that cannot run as browser JS — their presence in
// a brief means there's a real program to actually build and run. Checked FIRST
// (most specific). "go"/"c"/"java" are too common as bare words, so they're
// gated to toolchain/file/role phrasings; "java" must not match "javascript".
const COMPILED_NATIVE_RE = new RegExp(
  [
    "\\b(?:rust|cargo|rustc)\\b",
    "\\bray\\s?trac(?:er|ing)\\b",            // the canonical "rust raytracer" ask
    "\\bgolang\\b",
    "\\bgo\\s+(?:program|binary|app|application|server|cli|module|package)\\b",
    "\\bc\\+\\+|\\bcpp\\b",
    "\\bc\\s+(?:program|binary)\\b",
    "\\b(?:gcc|clang|g\\+\\+|cmake)\\b",
    "\\bzig\\b",
    "\\bswift\\s+(?:program|app|package)\\b",
    "\\bkotlin\\b",
    "\\bjava\\b(?!script)\\s+(?:program|app|application|class)\\b",
    "\\b(?:native\\s+binary|native\\s+executable|compiled\\s+(?:program|binary|language))\\b",
    "\\.(?:rs|go|cpp|cxx|zig)\\b",
  ].join("|"),
  "i",
);

// Build-step FRONTEND signals — a framework whose dev surface is a dev server
// with HMR, NOT a static index.html. These get their own tier (frontend-spa) so
// the builder is told to scaffold a REAL project + run app_serve_frontend, and
// the static dashboard seed is skipped — otherwise the model edits the seeded
// index.html into a page that merely DESCRIBES the framework (the live Vite-fake
// failure). HIGH PRECISION: a named build tool, or a framework WITH an artifact
// noun. Bare "react"/"vue" alone do NOT qualify (a plain HTML app uses them).
const FRONTEND_SPA_RE = new RegExp(
  [
    // build-step toolchains / metaframeworks (a real dev server)
    "\\b(?:vite|webpack|rollup|parcel|esbuild|next\\.?js|nuxt|svelte\\s?kit|remix|astro|gatsby)\\b",
    // frontend frameworks WITH an artifact noun (implies a build step)
    "\\b(?:react|vue|angular|svelte|solid|preact)(?:\\.?js)?\\s+(?:app|project|application|spa|frontend|front-?end|site|dashboard|component|ui)\\b",
  ].join("|"),
  "i",
);

// Real-BACKEND signals, HIGH PRECISION only — split into HARD and SOFT so a
// NEGATED mention ("no backend", "client-side") can't fake a backend into being.
//
// HARD: a named server/db engine, explicit "full-stack", an API server — an
// unambiguous server process the static path can't honestly provide. These win
// full-stack even alongside a "no backend" (a self-contradictory prompt that
// names Postgres still needs Postgres). Deliberately omits bare "dashboard",
// "database", "db", "api" — all of which a plain HTML app uses.
const FULL_STACK_HARD_RE = new RegExp(
  [
    // backend servers / frameworks (named)
    "\\b(?:express|fastify|nest\\.?js|koa|hapi|django|flask|fastapi|rails|laravel|spring\\s?boot|node\\s+server|api\\s+server|rest\\s+api|graphql|web\\s?socket\\s+server)\\b",
    // explicit full-stack phrasing
    "\\bfull[-\\s]?stack\\b",
    // real database engines / ORMs (named — not the bare word "database")
    "\\b(?:postgres(?:ql)?|mysql|mariadb|mongo(?:db)?|redis|sqlite|prisma|drizzle|sequelize|supabase|firebase|firestore)\\b",
    // run-a-dev-server phrasing
    "\\bnpm\\s+run\\s+dev\\b",
  ].join("|"),
  "i",
);

// SOFT: a bare "backend" / "server-side" mention. Real when unqualified ("build
// me a backend"), but a client-only app that says "no backend" / "client-side"
// used to trip this and get mis-routed to full-stack — the exact failure where a
// React SPA request became a faked static page. Suppressed when NEGATED_BACKEND_RE
// fires.
const FULL_STACK_SOFT_RE = /\b(?:back-?end|server-?side)\b/i;

// Negation / client-only framing that means "there is NO backend" — so a SOFT
// backend mention in the same prompt is describing what the app does NOT have.
const NEGATED_BACKEND_RE =
  /\b(?:no|without(?:\s+a)?|not\s+a)\s+(?:back-?end|server)\b|\bclient[-\s]?side\b|\bserverless\b|\bno[-\s]?server\b/i;

/** True when the brief genuinely implies a real backend: a HARD signal always,
 *  or a SOFT signal that isn't negated by client-only framing. */
function impliesFullStack(text: string): boolean {
  if (FULL_STACK_HARD_RE.test(text)) return true;
  return FULL_STACK_SOFT_RE.test(text) && !NEGATED_BACKEND_RE.test(text);
}

// Real-APP phrasing — a plain-English request for a real multi-screen app that
// names NO framework. This is the routing fix for the common case: a normal
// person asks for "an app for my car wash with login and a dashboard" and never
// types "vite" or "react", so the framework-keyword-only FRONTEND_SPA_RE misses
// it and it falls to quick-html — a login+dashboard app crammed into one static
// page. HIGH PRECISION, and checked AFTER full-stack so a named backend engine
// (postgres/express/…) still wins full-stack: only real-app SIGNALS a static
// page can't honestly be, never the soft words a plain HTML app legitimately
// uses ("dashboard", "tracker", "tool", "app" alone, "landing page"). Three
// buckets: real authentication, explicit multi-view, explicit app-platform
// framing. "SPA" as a bare token is deliberately omitted — it collides with the
// word "spa" (a salon/spa booking app is not a single-page-app signal).
const REAL_APP_RE = new RegExp(
  [
    // authentication — a real login/signup implies state, routing, a real app
    "\\b(?:log\\s?in|sign\\s?in|sign\\s?up|sign-in|sign-up|authentication|user\\s+accounts?|user\\s+auth)\\b",
    // explicit multi-view — needs routing, not a single static page
    "\\b(?:multi[-\\s]?page|multi[-\\s]?screen|multiple\\s+(?:pages|screens|views)|several\\s+(?:pages|screens))\\b",
    // explicit app-platform framing (bare "SPA" omitted — collides with "spa")
    "\\b(?:web\\s?app|single[-\\s]?page\\s+app|SaaS|PWA|progressive\\s+web\\s+app)\\b",
  ].join("|"),
  "i",
);

/**
 * Classify a build brief into one of the four app tiers. Precedence:
 * compiled-native (most specific) → frontend-spa (framework named) → full-stack
 * (backend engine named) → frontend-spa (plain-English real-app phrasing) →
 * quick-html. frontend-spa's framework-keyword gate is checked before full-stack
 * so "full-stack react app" lands on the SPA path (skips the static seed, covers
 * adding a backend). The real-app-phrasing gate is checked AFTER full-stack so a
 * named backend engine still wins full-stack; it catches real apps described in
 * plain words (login/multi-page/web-app) that name no framework — the case that
 * used to fall through to a faked static page.
 */
export function classifyAppTier(prompt: string): AppTier {
  const text = prompt || "";
  if (COMPILED_NATIVE_RE.test(text)) return "compiled-native";
  if (FRONTEND_SPA_RE.test(text)) return "frontend-spa";
  if (impliesFullStack(text)) return "full-stack";
  if (REAL_APP_RE.test(text)) return "frontend-spa";
  return "quick-html";
}

/**
 * Tier resolution for build_app: regex verdict, plus the LLM escalation on
 * the quick-html residue. The regex classifier's hard signals (named
 * toolchain/framework/engine) are trusted as-is. Its quick-html verdict is
 * the low-confidence residue where real apps described in plain words get
 * faked as a static page — consult the LLM there, escalation-only:
 * null/timeout keeps the regex verdict, so an LLM outage can never
 * downgrade a build toward faking.
 *
 * The same escalation may instead return a clarify verdict when the quick-html
 * residue is materially ambiguous (target might not be software, or the builds
 * diverge). That only reaches here from the plain-word residue and fails open
 * to the regex tier, so a clear build is never turned into a question.
 */
export async function resolveAppTier(prompt: string): Promise<AppTier | AppTierClarify> {
  const tier = classifyAppTier(prompt);
  if (tier !== "quick-html") return tier;
  const escalated = await classifyAppTierEscalation({ prompt });
  if (!escalated) return tier;
  if (typeof escalated !== "string") return escalated; // clarify verdict
  return escalated !== "quick-html" ? escalated : tier;
}

/** Human-readable label for logs / op descriptions. */
export function tierLabel(tier: AppTier): string {
  switch (tier) {
    case "compiled-native": return "compiled-native program";
    case "frontend-spa": return "frontend SPA (live dev server)";
    case "full-stack": return "full-stack app (real backend)";
    case "quick-html": return "quick HTML app";
  }
}

/**
 * Render a clarify verdict into a build_app tool result the model relays to the
 * user. Framed as a do-not-build instruction with the scoped options so a
 * tool-shy model surfaces the question instead of guessing and building wrong.
 */
export function formatClarify(c: AppTierClarify): string {
  const opts = c.options.map((o, i) => `${i + 1}. ${o}`).join("\n");
  return `AMBIGUOUS BUILD REQUEST — do not build yet. Ask the user this one question, list the options, and wait for their answer:\n\n${c.question}\n${opts}\n\nOnce they choose, call build_app again with a prompt that reflects their choice.`;
}
