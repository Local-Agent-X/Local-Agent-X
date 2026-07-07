/**
 * Builder-prompt rendering — lifted out of builder-tools.ts so both the
 * CLI-subprocess path and the canonical-op path render from the same source.
 *
 * Pure renderer at the top, fs-touching helpers at the bottom. The pure
 * functions take pre-read inputs only; the caller is responsible for any
 * disk reads (assets walk, existing-app context).
 */

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import type { AppTier } from "./app-tier.js";
import { selectDesignBrief, DESIGN_ANTI_PATTERNS } from "./design-brief.js";

const WEBSITE_NOUN_IN_PROMPT_RE =
  /\b(website|web ?site|landing page|landing|home ?page|marketing ?page|micro ?site|one[- ]?pager|business site|biz site|menu page|portfolio|splash page|brochure site)\b/i;

export function looksLikeWebsiteRequest(prompt: string): boolean {
  return WEBSITE_NOUN_IN_PROMPT_RE.test(prompt);
}

export const WEBSITE_RULES_FRAGMENT = [
  "",
  "WEBSITE-BUILD MODE — apply these rules:",
  "• NEVER use placeholder.com, lorem-picsum, unsplash random, or any external stock CDN. If real photos exist in the `assets/` folder of this app dir, USE THEM. If none exist, ask via the conversation rather than inventing placeholders.",
  "• NO TEXT WALLS. Hero needs a real image (not a color block) plus a short headline + sub + CTA. Each major section needs a visual anchor (photo, icon, or card). If a section has >60 words of body text without a visual, restructure it.",
  "• IMAGE DISCIPLINE. Every <img> gets explicit width/height OR aspect-ratio, object-fit: cover, loading=\"lazy\", and max-width: 100%. Hero caps at 80vh. Photo grids force consistent ratios so portrait/landscape mix doesn't blow up the layout. Never let a native-resolution photo render at native size.",
  "• MOBILE FIRST. Default to mobile breakpoint, layer up to desktop with media queries. Use clamp() for fluid type and CSS grid/flex for layout.",
  "• HIERARCHY: Hero → social proof or photo grid → menu/services as cards → contact/CTA. Modern type scale, generous whitespace, color palette that fits the brand.",
  "• Light mode by default unless the brand source clearly uses dark.",
  "",
].join("\n");

// Honesty rules for the case where the requested app isn't a web page — a
// Rust/Go/C native program, a CLI, anything needing a real compiler/runtime. The
// HTML-first contract tempts the model to sideline real compiled code, ship a JS
// reimplementation, and falsely claim it "matches" the real output. These two
// lines reach BOTH build strategies (spliced into the persona AND the per-build
// RULES), and the app-build verify gate enforces the second one. Shared as one
// const so the two splice points can't drift.
export const NATIVE_BUILD_RULE_LINES = [
  "- Building something that isn't a web page — a Rust/Go/C/C++/native program, a CLI, anything needing a real compiler or runtime? Actually build and RUN it with its real toolchain via bash (e.g. `cargo run`, `go run .`, `cc main.c && ./a.out`), and make index.html show the REAL output it produced — embed the generated image/file, or the captured real stdout. Do NOT reimplement the program in browser JavaScript and present that as its result.",
  "- Never claim a preview \"matches\", is \"identical to\", or is \"the same as\" a program's real output unless you actually ran that program and are showing its real output. If you genuinely can't run the toolchain in this sandbox, say so plainly and show only what you verified — an honest \"couldn't compile/run it here\" beats a fabricated match.",
];

// Tier-specific RULES, spliced into the per-build context after the shared
// NATIVE_BUILD_RULE_LINES. quick-html adds nothing (the default funnel is
// already right for it), so a quick build's prompt is byte-identical to before
// this seam existed. full-stack and compiled-native get the real-build path:
// run the toolchain / stand up the backend instead of faking an HTML twin.
// The app directory path can contain SPACES (an installed app lives under
// e.g. "…/Local Agent X/workspace/apps/<id>"). An unquoted path in a shell
// command splits on the space — the real failure: `cd …/Local Agent X/… && npm
// install` ran in `…/Local` and npm couldn't find package.json. Only emitted
// when the path actually has a space, so a space-free dev checkout sees no
// noise. Shared across every real-build tier (each shells against appDir).
function shellPathQuotingLines(appDir: string): string[] {
  if (!appDir.includes(" ")) return [];
  return [
    `- The app directory path contains SPACES — ALWAYS wrap paths in double quotes in shell commands (e.g. \`cd "${appDir}" && npm install\`). An unquoted path splits on the space and the command runs in the wrong directory (npm/cargo then can't find the project).`,
  ];
}

export function fullStackRuleLines(appName: string, appDir: string): string[] {
  return [
    "",
    "FULL-STACK MODE — this app needs a REAL backend; do NOT fake it with hardcoded data in index.html:",
    ...shellPathQuotingLines(appDir),
    `- Build a real backend under ${appDir}/server in whatever language the request implies — Node + Express is a fine default; Python + Flask/FastAPI, Go, etc. are equally fine.`,
    `- STORAGE: prefer a built-in / no-compile store — Node → import { DatabaseSync } from "node:sqlite"; Python → the stdlib sqlite3 module. Persist to ${appDir}/server/data.db; these need NO install and NO native build, so they can't fail to compile.`,
    `- NATIVE DEPENDENCIES (better-sqlite3, bcrypt, argon2, sharp, canvas, …): depend ONLY on the LATEST version (e.g. "better-sqlite3": "latest") so the package manager fetches a prebuilt matching this machine's runtime. NEVER pin an old version like "^9.x" — old native modules have no prebuilt for a current runtime, fall back to a source compile, and fail, leaving the app with a dead backend.`,
    `- Start it with ONE call: app_serve_backend({ app_id: "${appName}", command: "<your stack's install + run>", port: <the port it listens on> }) — e.g. Node: "cd server && npm install && npm run dev"; Python: "cd server && pip install -r requirements.txt && python app.py". The command runs from the APP ROOT (${appDir}). app_serve_backend starts it, VERIFIES it actually binds the port, keeps it alive (restart on open, stop on delete), and wires the connector. Do NOT start a dev server with bash — it blocks and times out.`,
    `- index.html (the served frontend) reaches the backend through that connector, NOT a direct localhost fetch — a direct http://localhost fetch breaks the moment the app is opened from the phone, where "localhost" is the phone and not this machine. Fetch the same-origin proxy /api/connectors/dev-${appName}/<path> with header Authorization: 'Bearer ' + window.__LAX_CONNECTOR_TOKEN__.`,
    `- After you EDIT backend source (anything under ${appDir}/server), the running dev server keeps the OLD code until it restarts. Re-run the SAME app_serve_backend({ app_id: "${appName}", command, port }) call — it does a clean restart so your changes take effect. Don't tell the user the backend is fixed without restarting it.`,
    `- FRONTEND WITH A BUILD STEP (Vite / Next / a React/Vue/Svelte SPA with HMR), not a single static index.html? Build it under ${appDir}, then in its dev-server config set base to "/apps/${appName}/" AND the HMR client port to the dev port (e.g. Vite: \`base: '/apps/${appName}/', server: { port: <P>, host: true, hmr: { clientPort: <P>, host: 'localhost' } }\`), and start it with app_serve_frontend({ app_id: "${appName}", command: "npm install && npm run dev", port: <P> }). LAX reverse-proxies /apps/${appName}/ to it — so the app URL serves the live dev server. Hot-reload works on desktop; the phone shows the result on reload. Without the base + HMR-port config, assets and hot-reload 404. (A plain static frontend does NOT need this — just write index.html.)`,
    "- The backend is real and persistent — never hardcode sample rows in the frontend to simulate it. Show an honest empty/error state until the real API returns.",
  ];
}

export function frontendSpaRuleLines(appName: string, appDir: string): string[] {
  return [
    "",
    "FRONTEND-SPA MODE — this is a REAL build-step frontend (Vite / Next / a React/Vue/Svelte SPA with HMR), NOT a static HTML page. Writing a static index.html that merely LOOKS like or DESCRIBES the framework is the exact failure this mode exists to prevent — do not do it.",
    ...shellPathQuotingLines(appDir),
    `- Scaffold a REAL project under ${appDir}: a package.json with the framework's real deps, the framework config file, and source under src/. e.g. Vite+React: package.json, vite.config.js, index.html with <script type="module" src="/src/main.jsx">, and src/main.jsx + src/App.jsx. There is NO seeded starter — create these files.`,
    `- In the dev-server config, set the base path to "/apps/${appName}/" AND the HMR client port to the dev port — Vite: \`base: '/apps/${appName}/', server: { port: <P>, host: true, hmr: { clientPort: <P>, host: 'localhost' } }\`. Without this, assets and hot-reload 404.`,
    `- Start it with app_serve_frontend({ app_id: "${appName}", command: "npm install && npm run dev", port: <P> }). LAX reverse-proxies /apps/${appName}/ to the live dev server (HMR on desktop). app_serve_frontend VERIFIES the dev server actually bound its port — if it reports a failure, FIX the project; do NOT fall back to a static page.`,
    "- The deliverable is the live DEV server — nothing else. Once app_serve_frontend reports it's up, you are DONE. Do NOT run any extra tooling: no production build (`npm run build` / `vite build` / `next build`), no lint (`npm run lint` / eslint), no typecheck, no tests. The proxy serves the dev server, not a dist/ bundle, and these steps add nothing but a chance to error on a bleeding-edge version and derail you. Skip them entirely. (Don't even add eslint/test deps unless asked.)",
    "- You are NOT done until app_serve_frontend reports the dev server is up. A hand-written page imitating the app does not count. If the app ALSO needs a backend API, additionally call app_serve_backend.",
  ];
}

export function compiledRuleLines(appDir: string): string[] {
  return [
    "",
    "COMPILED-LANGUAGE MODE — this is a real compiled program (Rust/Go/C/C++/…), not a web page:",
    ...shellPathQuotingLines(appDir),
    `- Actually compile and RUN it with its real toolchain. A compile can exceed the bash timeout — prefer the process_start tool for the build/run (e.g. process_start({command: "cargo run --release", cwd: "${appDir}"})) and poll process_status until it finishes; use bash only for fast commands.`,
    "- The DELIVERABLE is the program's REAL output artifact — the image/file it generated, or its captured stdout — NOT an app and NOT a dashboard.",
    "- Write index.html as a MINIMAL full-bleed VIEWER of that single artifact and nothing else: the generated image filling the page (dark background, object-fit: contain, no chrome), or the raw stdout in a <pre>. NO cards, stats, headers, navigation, descriptions, controls, or surrounding UI — the artifact IS the page, so the app's link opens straight to the render.",
    "- Do NOT reimplement the program in browser JavaScript and present that as its result.",
  ];
}

/** "" for quick-html (byte-identical to the pre-tier prompt); a leading-newline
 *  block for the real-build tiers. */
function renderTierBlock(tier: AppTier, appName: string, appDir: string): string {
  const lines = tier === "full-stack" ? fullStackRuleLines(appName, appDir)
    : tier === "frontend-spa" ? frontendSpaRuleLines(appName, appDir)
    : tier === "compiled-native" ? compiledRuleLines(appDir)
    : [];
  return lines.length > 0 ? "\n" + lines.join("\n") : "";
}

export interface BuilderPromptInput {
  appName: string;
  prompt: string;
  appDir: string;
  appUrl: string;
  isUpdate: boolean;
  /** App tier — drives the tier-specific RULES block. Defaults to quick-html
   *  (no extra rules) when omitted, so existing quick builds are unchanged. */
  tier?: AppTier;
  /** Pre-read context blocks (e.g. PROJECT.md / TODO.md / index.html sections).
   *  Each entry is the full block including its `=== FILE ===` header. */
  contextFiles: string[];
  /** Pre-walked asset file paths, relative to appDir, forward-slash separated. */
  assetFiles: string[];
}

/**
 * Per-build context block — everything that varies per invocation. Matches
 * the per-build prefix of the legacy builder-tools.ts template literally,
 * up to and including the final `APP_READY:` line. Phase 2 prepends this
 * to the agent template's persona at op-submit time.
 */
export function renderPerBuildContext(input: BuilderPromptInput): string {
  const { appName, prompt, appDir, appUrl, isUpdate, contextFiles, assetFiles } = input;
  const isWebsite = looksLikeWebsiteRequest(prompt);
  const tierBlock = renderTierBlock(input.tier ?? "quick-html", appName, appDir);
  // Visual design guidance, per build. Lives here, in the per-build context, so
  // it reaches EVERY build path without touching the persisted persona
  // (renderPersonaPrompt) and its drift-refresh. The archetype brief keys off
  // the app DESCRIPTION, which only a CREATE carries; an UPDATE's prompt is a
  // change instruction ("add a payments page"), so classifying it would inject a
  // mismatched archetype — the established design in the existing files governs
  // the look on updates. Updates still get the universal anti-patterns.
  const design = isUpdate ? null : selectDesignBrief(prompt);

  const context = contextFiles.length > 0
    ? `\n\nExisting app context:\n${contextFiles.join("\n\n")}`
    : "";

  const assetManifest = assetFiles.length > 0
    ? `\n\nLOCAL ASSETS AVAILABLE (use these in <img src="..."> — relative to index.html):\n${assetFiles.map(p => `  - ${p}`).join("\n")}\n`
    : (isWebsite
        ? `\n\nNO LOCAL ASSETS YET. If the user mentioned a source URL or attached photos, the parent agent should have extracted them into assets/ before invoking you. Do NOT use placeholder.com or stock CDNs — instead, build a bold typography-driven hero with CSS gradients and ask in PROJECT.md for the photos to be added.\n`
        : "");

  // The real-build tiers (compiled-native, frontend-spa) skip the seed
  // (build-app.ts) so the model can't fake the build by editing a static
  // starter — don't tell the agent to edit one that isn't there.
  const realBuildTier = input.tier === "compiled-native" || input.tier === "frontend-spa";
  const starterLine = (isUpdate || realBuildTier)
    ? ""
    : "- An index.html starter + AGENTS.md have been seeded — READ both, then EDIT index.html rather than rewriting it from scratch. Keep the inline-only CSP rule.\n";

  // Update builds get repair rules the create path doesn't need: the context
  // block may be partial (see readUpdateContextFiles), and a fixer that only
  // patches what it can see ships differently-broken code. Rewrite authority
  // is explicit because the edit-in-place framing otherwise reads as "minimal
  // patches only" — the wrong contract when the diagnosis is a broken approach
  // (e.g. hand-rolled 3D projection math that can't be patched correct).
  const updateRules = isUpdate
    ? "- Before changing ANY file, READ it in full with your read tool — the context block above may be truncated, and patching code you haven't seen ships broken fixes.\n" +
      "- Diagnose the root cause before editing. If the current approach is fundamentally wrong (broken math, unsalvageable rendering technique, dead-end architecture), REWRITE the affected file or subsystem using a sound, proven approach. You are NOT limited to minimal patches — a correct rewrite beats a bandage on a broken design.\n"
    : "";

  return `You are building a web app in the directory: ${appDir}
App name: ${appName}
Task: ${isUpdate ? "UPDATE existing app" : "CREATE new app"}

Environment:
- Files in this folder are served at: ${appUrl}
- The preview iframe enforces this CSP: script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: https: blob:; font-src 'self' data:; connect-src 'self'.
- External CDNs (Tailwind, jsdelivr, unpkg, Google Fonts) are blocked at the network layer. Inline or self-host.
- Need real data from an external API? You CANNOT fetch it cross-origin here (connect-src 'self' blocks it) and you must NOT edit core LAX. Call the connector_create tool to define a connector (name, upstream, auth none/bearer/header/signed, allow-list of exact "METHOD /path" entries), then have the app call the same-origin proxy /api/connectors/<name>/<path> with header Authorization: 'Bearer ' + window.__LAX_CONNECTOR_TOKEN__. The server holds the secret and forwards. An honest empty/error state until it returns is fine; faked data is not.
- After write/edit, the preview reloads automatically; runtime errors are forwarded back to you in the next turn.
${context}${assetManifest}
Instructions: ${prompt}

RULES:
- Write ALL files to ${appDir}/ (use absolute paths)
- The main entry point MUST be index.html
${starterLine}${updateRules}- Create PROJECT.md with app description and status
- Pick ONE emoji that best represents this app and write JUST that emoji (nothing else) to a file named .icon in ${appDir}/ — it becomes the app's launcher icon on the phone home screen. Avoid generic glyphs (📦/📁/📄)
- For single-page apps: put everything in index.html (inline CSS/JS is fine)
- Make it look polished — use modern CSS, good colors, responsive design
${NATIVE_BUILD_RULE_LINES.join("\n")}${tierBlock}
- The app will be served at ${appUrl}
- Do NOT ask questions — just build it based on the instructions

${design ? `${design.brief}\n\n` : ""}${DESIGN_ANTI_PATTERNS}

- After writing files, output: APP_READY: ${appUrl}`;
}

/**
 * Persona prompt — self-contained agent identity + static rules. Goes in the
 * AgentTemplate.systemPrompt for the canonical-op path. The same WEBSITE_RULES
 * the legacy template injects inline are always included here so the agent
 * has them available without per-build gating.
 *
 * Stable (no inputs): two calls return the same string. Snapshot-tested.
 */
export function renderPersonaPrompt(): string {
  return [
    "You are the App Builder agent. You build complete web apps in the directory provided by the per-build context block prepended to each request.",
    "",
    "Static rules that apply to every build (per-build context carries the appDir, appUrl, existing-app context, asset manifest, and the user's instructions):",
    "- The main entry point MUST be index.html",
    "- Create PROJECT.md with app description and status",
    "- Pick ONE emoji that best represents the app and write JUST that emoji (nothing else) to a file named .icon in the app folder — it becomes the app's launcher icon on the phone home screen. Avoid generic glyphs (📦/📁/📄)",
    "- For single-page apps: put everything in index.html (inline CSS/JS is fine)",
    "- Make it look polished — use modern CSS, good colors, responsive design",
    "- Use real data and real logic — never fake it. No `Math.random()` stand-ins for live values, no hardcoded sample arrays posing as a real feed, no placeholder rows. If a real data source isn't wired, show an explicit empty/error state instead of fabricating content.",
    "- Every control must work — buttons, forms, inputs, and links you add must do what they say, with no handlers wired to nothing.",
    "- The app must run on first load — include every script, style, and handler it references; no functions called but never defined, no half-wired features.",
    ...NATIVE_BUILD_RULE_LINES,
    "- Need real data from an external API (broker, CRM, any keyed/signed service)? Don't fetch it directly — the sandbox blocks cross-origin calls. Call the connector_create tool to define a connector (upstream + auth + an allow-list of exact METHOD /path entries) and have the app call the same-origin proxy /api/connectors/<name>/<path> with the header Authorization: 'Bearer ' + window.__LAX_CONNECTOR_TOKEN__. Never edit core LAX to add an integration.",
    "- Do NOT ask questions — just build it based on the instructions",
    "- After writing files, output: APP_READY: <appUrl from the per-build context>",
    WEBSITE_RULES_FRAGMENT +
      "When the per-build context indicates a website request (or includes the WEBSITE-BUILD MODE rules), follow the rules above.",
  ].join("\n");
}

const APP_BUILDER_PERSONA_OPENER = "You are the App Builder agent.";

/**
 * Decide the refreshed app-builder systemPrompt for a persisted template.
 * The template store seeds built-ins only on first run, so edits to the
 * code-derived persona never reached an already-seeded store — the builder ran
 * a stale prompt. Returns the fresh persona when the stored one is a built-in
 * that drifted, or null to leave it untouched (a user who rewrote the persona
 * from scratch, losing the built-in opener, keeps theirs).
 */
export function appBuilderPersonaRefresh(stored: string, fresh: string): string | null {
  if (!stored.startsWith(APP_BUILDER_PERSONA_OPENER)) return null;
  if (stored === fresh) return null;
  return fresh;
}

/**
 * Legacy single-prompt renderer — byte-identical to the inline template that
 * lived in builder-tools.ts before this extraction. Used by the legacy
 * CLI-subprocess path until Phase 2 of the migration replaces it.
 *
 * Composed as: renderPerBuildContext(input) + "\n" + (website-rules-or-empty).
 * The trailing newline matches the legacy template's final `\n${websiteRules}`
 * placement.
 */
export function renderBuilderPrompt(input: BuilderPromptInput): string {
  const isWebsite = looksLikeWebsiteRequest(input.prompt);
  return renderPerBuildContext(input) + "\n" + (isWebsite ? WEBSITE_RULES_FRAGMENT : "");
}

// ── fs helpers (caller invokes; pure renderer above must stay disk-free) ────

/**
 * Walk the app's `assets/` folder and return image paths relative to appDir,
 * sorted, with forward-slash separators. Returns [] if the dir doesn't exist
 * or contains no images.
 */
export function listAssetsDir(appDir: string): string[] {
  const dir = join(appDir, "assets");
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  const walk = (cur: string): void => {
    let entries: string[] = [];
    try { entries = readdirSync(cur); } catch { return; }
    for (const name of entries) {
      const p = join(cur, name);
      let s: ReturnType<typeof statSync>;
      try { s = statSync(p); } catch { continue; }
      if (s.isDirectory()) { walk(p); continue; }
      if (s.isFile() && /\.(jpg|jpeg|png|webp|avif|gif|svg)$/i.test(name)) {
        out.push(relative(appDir, p).replace(/\\/g, "/"));
      }
    }
  };
  walk(dir);
  return out.sort();
}

/**
 * Per-file cap for update context seeded verbatim into the build prompt.
 * Small enough that three maxed files stay under ~100KB (fine for every
 * hosted provider and the local-model default context), large enough that a
 * typical single-file app (10-20KB) is seeded WHOLE. The old 3KB slice cut
 * a 15KB game off inside its stylesheet, so the update build patched logic
 * it had never seen — the truncation was silent and the fixer had no idea.
 */
export const UPDATE_CONTEXT_FILE_CAP = 32_000;

/**
 * Read the standard update-context files (PROJECT.md, TODO.md, index.html)
 * from an existing app dir, formatted as `=== FILE ===\n<contents>` blocks.
 * Files at or under {@link UPDATE_CONTEXT_FILE_CAP} are included in full.
 * Larger files are truncated LOUDLY: the block says how much is missing and
 * orders a full read before editing — a silent fragment is the failure mode
 * this replaces. Returns [] if no files exist.
 */
export function readUpdateContextFiles(appDir: string): string[] {
  const blocks: string[] = [];
  for (const f of ["PROJECT.md", "TODO.md", "index.html"]) {
    const p = join(appDir, f);
    if (existsSync(p)) {
      try {
        const content = readFileSync(p, "utf-8");
        if (content.length <= UPDATE_CONTEXT_FILE_CAP) {
          blocks.push(`=== ${f} (complete) ===\n${content}`);
        } else {
          blocks.push(
            `=== ${f} (TRUNCATED — showing first ${UPDATE_CONTEXT_FILE_CAP} of ${content.length} chars) ===\n` +
            `${content.slice(0, UPDATE_CONTEXT_FILE_CAP)}\n` +
            `[…TRUNCATED. You have NOT seen the rest of this file. READ the full file with your read tool before editing it — never patch code you haven't seen.]`,
          );
        }
      } catch { /* skip */ }
    }
  }
  return blocks;
}
