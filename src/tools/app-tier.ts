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
 * for real instead of faking. It is deterministic on purpose — an LLM tier call
 * could time out and fall back to "quick-html", which is precisely the silent
 * faking we're trying to kill. Predictable, explainable, no fallback-to-fake.
 *
 * Bias: CONSERVATIVE toward quick-html. The product default is fast HTML apps,
 * so full-stack fires only on high-precision signals (named frameworks, servers,
 * real DB engines) — never on soft words like "dashboard", "database", or "db"
 * that a plain HTML app legitimately uses. False negatives (a real backend ask
 * read as quick-html) are acceptable and recoverable; false positives (a simple
 * dashboard shoved into the heavy path) hurt the common case, so we avoid them.
 */

export type AppTier = "quick-html" | "full-stack" | "compiled-native";

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

// Real-backend / build-step signals. HIGH PRECISION only — every entry here
// genuinely implies a compiler/bundler or a server process the static HTML path
// can't honestly provide. Deliberately omits "dashboard", "database", "db",
// "api" (bare), and "react" (bare) — all of which a plain HTML app uses.
const FULL_STACK_RE = new RegExp(
  [
    // build-step frontend toolchains / metaframeworks
    "\\b(?:vite|webpack|rollup|parcel|esbuild|next\\.?js|nuxt|svelte\\s?kit|remix|astro|gatsby)\\b",
    // backend servers / frameworks
    "\\b(?:express|fastify|nest\\.?js|koa|hapi|django|flask|fastapi|rails|laravel|spring\\s?boot|node\\s+server|backend|back-?end|server-?side|api\\s+server|rest\\s+api|graphql|web\\s?socket\\s+server)\\b",
    // explicit full-stack phrasing
    "\\bfull[-\\s]?stack\\b",
    // real database engines / ORMs (named — not the bare word "database")
    "\\b(?:postgres(?:ql)?|mysql|mariadb|mongo(?:db)?|redis|sqlite|prisma|drizzle|sequelize|supabase|firebase|firestore)\\b",
    // frontend frameworks WITH an artifact noun (implies a build step)
    "\\b(?:react|vue|angular|svelte|solid|preact)(?:\\.?js)?\\s+(?:app|project|application|spa|frontend|front-?end|site|dashboard|component|ui)\\b",
    // run-a-dev-server phrasing
    "\\bnpm\\s+run\\s+dev\\b",
  ].join("|"),
  "i",
);

/**
 * Classify a build brief into one of the three app tiers. Precedence:
 * compiled-native (most specific) → full-stack → quick-html (default).
 */
export function classifyAppTier(prompt: string): AppTier {
  const text = prompt || "";
  if (COMPILED_NATIVE_RE.test(text)) return "compiled-native";
  if (FULL_STACK_RE.test(text)) return "full-stack";
  return "quick-html";
}

/** Human-readable label for logs / op descriptions. */
export function tierLabel(tier: AppTier): string {
  switch (tier) {
    case "compiled-native": return "compiled-native program";
    case "full-stack": return "full-stack app (real backend)";
    case "quick-html": return "quick HTML app";
  }
}
