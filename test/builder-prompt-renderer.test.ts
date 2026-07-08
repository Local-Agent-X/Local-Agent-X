/**
 * Pins the builder-prompt renderer extracted from builder-tools.ts in Phase 1
 * of docs/migration/build-app-to-canonical-op.md.
 *
 * The renderer is the single source of truth for both the legacy CLI-subprocess
 * path (today) and the canonical-op path (Phase 2).
 *
 * History: the byte-parity-vs-extraction guarantee was originally pinned by a
 * hand-maintained inline mirror of the template. That mirror had to be
 * re-synced for every intentional prompt change (37351ab0) and then silently
 * missed one (668abc25 added the update repair rules; the mirror didn't) —
 * the exact drift it existed to catch. The byte-level pin now lives in file
 * snapshots (one machine-maintained source of truth): any renderer change
 * fails these tests until reviewed and accepted with `vitest -u`, and the
 * accepted diff shows exactly what the subprocess prompt now says. The
 * compose contract (full prompt = per-build context + website-rules tail) is
 * asserted against the real module exports.
 */
import { describe, it, expect } from "vitest";
import {
  renderBuilderPrompt,
  renderPersonaPrompt,
  renderPerBuildContext,
  looksLikeWebsiteRequest,
  appBuilderPersonaRefresh,
  WEBSITE_RULES_FRAGMENT,
  NATIVE_BUILD_RULE_LINES,
  fullStackRuleLines,
  compiledRuleLines,
  type BuilderPromptInput,
} from "../src/tools/render-builder-prompt.js";

const SAMPLE_CREATE: BuilderPromptInput = {
  appName: "todo-app",
  prompt: "Build me a single-page todo app with local storage.",
  appDir: "/abs/workspace/apps/todo-app",
  appUrl: "http://127.0.0.1:7007/apps/todo-app/index.html",
  isUpdate: false,
  contextFiles: [],
  assetFiles: [],
};

const SAMPLE_UPDATE: BuilderPromptInput = {
  appName: "trading-bot",
  prompt: "Add a fee-protection toggle to the settings panel.",
  appDir: "/abs/workspace/apps/trading-bot",
  appUrl: "http://127.0.0.1:7007/apps/trading-bot/index.html",
  isUpdate: true,
  contextFiles: [
    "=== PROJECT.md ===\nTrading bot for Kraken. Status: live.",
    "=== TODO.md ===\n- [ ] fee toggle\n- [ ] settings export",
  ],
  assetFiles: [],
};

const SAMPLE_WEBSITE_WITH_ASSETS: BuilderPromptInput = {
  appName: "initech",
  prompt: "Build the Acme Springfield landing page — modern, photo-driven.",
  appDir: "/abs/workspace/apps/initech",
  appUrl: "http://127.0.0.1:7007/apps/initech/index.html",
  isUpdate: false,
  contextFiles: [],
  assetFiles: ["assets/hero.jpg", "assets/storefront.png", "assets/team.webp"],
};

const SAMPLE_WEBSITE_NO_ASSETS: BuilderPromptInput = {
  appName: "biz",
  prompt: "Build a one-pager landing page for my consulting business.",
  appDir: "/abs/workspace/apps/biz",
  appUrl: "http://127.0.0.1:7007/apps/biz/index.html",
  isUpdate: false,
  contextFiles: [],
  assetFiles: [],
};

describe("looksLikeWebsiteRequest", () => {
  it("matches website nouns", () => {
    expect(looksLikeWebsiteRequest("Build a landing page")).toBe(true);
    expect(looksLikeWebsiteRequest("modern website for my biz")).toBe(true);
    expect(looksLikeWebsiteRequest("a one-pager for consulting")).toBe(true);
  });

  it("does not match generic app requests", () => {
    expect(looksLikeWebsiteRequest("Build me a todo app")).toBe(false);
    expect(looksLikeWebsiteRequest("Add a settings panel")).toBe(false);
  });
});

describe("renderBuilderPrompt — compose contract + byte-level snapshot pin", () => {
  const CASES: Array<[string, BuilderPromptInput]> = [
    ["create + no assets + non-website", SAMPLE_CREATE],
    ["update + context files + non-website", SAMPLE_UPDATE],
    ["website + assets", SAMPLE_WEBSITE_WITH_ASSETS],
    ["website + no assets (includes the 'no assets yet' callout)", SAMPLE_WEBSITE_NO_ASSETS],
  ];

  // Compose contract, asserted against the real module exports: the legacy
  // single-prompt render is exactly the per-build context plus the trailing
  // website-rules slot ("\n" + fragment-or-empty, matching the old inline
  // template's `\n${websiteRules}` placement).
  it.each(CASES)("%s: full prompt = per-build context + website-rules tail", (_name, input) => {
    const tail = looksLikeWebsiteRequest(input.prompt) ? WEBSITE_RULES_FRAGMENT : "";
    expect(renderBuilderPrompt(input)).toBe(renderPerBuildContext(input) + "\n" + tail);
  });

  // Byte-level pin. Maintenance contract: an INTENTIONAL prompt change fails
  // this until you review the new output and accept it with `vitest -u` —
  // the snapshot diff in review shows exactly what the subprocess prompt now
  // says. There is no hand-maintained copy left to silently drift.
  it.each(CASES)("%s: full prompt is snapshot-pinned", (_name, input) => {
    expect(renderBuilderPrompt(input)).toMatchSnapshot();
  });

  it("website rendering ends with the WEBSITE_RULES_FRAGMENT", () => {
    const out = renderBuilderPrompt(SAMPLE_WEBSITE_NO_ASSETS);
    expect(out.endsWith(WEBSITE_RULES_FRAGMENT)).toBe(true);
  });

  it("non-website rendering omits the WEBSITE_RULES_FRAGMENT body", () => {
    const out = renderBuilderPrompt(SAMPLE_CREATE);
    expect(out).not.toContain("WEBSITE-BUILD MODE");
  });
});

describe("renderPerBuildContext — the per-build prefix of the full prompt", () => {
  it("create case: per-build is the full prompt trimmed of its trailing website-rules slot", () => {
    const full = renderBuilderPrompt(SAMPLE_CREATE);
    // Non-website tail is just "\n" (the `\n${websiteRules}` slot with
    // websiteRules=""). Per-build is everything before that final newline.
    expect(full.endsWith("\n")).toBe(true);
    expect(renderPerBuildContext(SAMPLE_CREATE)).toBe(full.slice(0, -1));
  });

  it("website case: per-build is the full prompt trimmed of '\\n' + WEBSITE_RULES_FRAGMENT", () => {
    const full = renderBuilderPrompt(SAMPLE_WEBSITE_WITH_ASSETS);
    const expectedTail = "\n" + WEBSITE_RULES_FRAGMENT;
    expect(full.endsWith(expectedTail)).toBe(true);
    expect(renderPerBuildContext(SAMPLE_WEBSITE_WITH_ASSETS))
      .toBe(full.slice(0, full.length - expectedTail.length));
  });

  it("includes the per-build appDir/appName/instructions", () => {
    const out = renderPerBuildContext(SAMPLE_CREATE);
    expect(out).toContain("App name: todo-app");
    expect(out).toContain(SAMPLE_CREATE.appDir);
    expect(out).toContain(SAMPLE_CREATE.appUrl);
    expect(out).toContain("Task: CREATE new app");
    expect(out).toContain("Instructions: " + SAMPLE_CREATE.prompt);
  });

  it("update task says UPDATE and embeds the supplied context files", () => {
    const out = renderPerBuildContext(SAMPLE_UPDATE);
    expect(out).toContain("Task: UPDATE existing app");
    expect(out).toContain("=== PROJECT.md ===");
    expect(out).toContain("=== TODO.md ===");
  });

  it("update prompt carries the repair rules (read-in-full + rewrite authority); create doesn't", () => {
    // 668abc25 added these to close the exception-free-but-broken build class;
    // the old hand-maintained mirror missed them — pin them semantically too,
    // not just via the snapshot.
    const out = renderPerBuildContext(SAMPLE_UPDATE);
    expect(out).toContain("READ it in full");
    expect(out).toContain("Diagnose the root cause before editing");
    expect(renderPerBuildContext(SAMPLE_CREATE)).not.toContain("Diagnose the root cause");
  });

  it("website + asset list renders the LOCAL ASSETS manifest", () => {
    const out = renderPerBuildContext(SAMPLE_WEBSITE_WITH_ASSETS);
    expect(out).toContain("LOCAL ASSETS AVAILABLE");
    expect(out).toContain("  - assets/hero.jpg");
    expect(out).toContain("  - assets/storefront.png");
  });

  it("website + zero assets renders the 'NO LOCAL ASSETS YET' fallback", () => {
    const out = renderPerBuildContext(SAMPLE_WEBSITE_NO_ASSETS);
    expect(out).toContain("NO LOCAL ASSETS YET");
  });

  it("includes the per-build Environment briefing block (CSP + auto-reload + appUrl)", () => {
    const out = renderPerBuildContext(SAMPLE_CREATE);
    expect(out).toContain("Environment:");
    expect(out).toContain("Files in this folder are served at: " + SAMPLE_CREATE.appUrl);
    expect(out).toContain("script-src 'self' 'unsafe-inline'");
    expect(out).toContain("External CDNs (Tailwind, jsdelivr, unpkg, Google Fonts) are blocked");
    expect(out).toContain("preview reloads automatically");
    expect(out).toContain("runtime errors are forwarded back to you in the next turn");
  });
});

describe("renderPersonaPrompt — stable persona for AgentTemplate.systemPrompt", () => {
  it("is deterministic across calls", () => {
    expect(renderPersonaPrompt()).toBe(renderPersonaPrompt());
  });

  it("snapshot — pins the persona content", () => {
    expect(renderPersonaPrompt()).toMatchInlineSnapshot(`
      "You are the App Builder agent. You build complete web apps in the directory provided by the per-build context block prepended to each request.

      Static rules that apply to every build (per-build context carries the appDir, appUrl, existing-app context, asset manifest, and the user's instructions):
      - The main entry point MUST be index.html
      - Create PROJECT.md with app description and status
      - Pick ONE emoji that best represents the app and write JUST that emoji (nothing else) to a file named .icon in the app folder — it becomes the app's launcher icon on the phone home screen. Avoid generic glyphs (📦/📁/📄)
      - For single-page apps: put everything in index.html (inline CSS/JS is fine)
      - Make it look polished — use modern CSS, good colors, responsive design
      - Use real data and real logic — never fake it. No \`Math.random()\` stand-ins for live values, no hardcoded sample arrays posing as a real feed, no placeholder rows. If a real data source isn't wired, show an explicit empty/error state instead of fabricating content.
      - Every control must work — buttons, forms, inputs, and links you add must do what they say, with no handlers wired to nothing.
      - The app must run on first load — include every script, style, and handler it references; no functions called but never defined, no half-wired features.
      - Building something that isn't a web page — a Rust/Go/C/C++/native program, a CLI, anything needing a real compiler or runtime? Actually build and RUN it with its real toolchain via bash (e.g. \`cargo run\`, \`go run .\`, \`cc main.c && ./a.out\`), and make index.html show the REAL output it produced — embed the generated image/file, or the captured real stdout. Do NOT reimplement the program in browser JavaScript and present that as its result.
      - Never claim a preview "matches", is "identical to", or is "the same as" a program's real output unless you actually ran that program and are showing its real output. If you genuinely can't run the toolchain in this sandbox, say so plainly and show only what you verified — an honest "couldn't compile/run it here" beats a fabricated match.
      - Need real data from an external API (broker, CRM, any keyed/signed service)? Don't fetch it directly — the sandbox blocks cross-origin calls. Call the connector_create tool to define a connector (upstream + auth + an allow-list of exact METHOD /path entries) and have the app call the same-origin proxy /api/connectors/<name>/<path> with the header Authorization: 'Bearer ' + window.__LAX_CONNECTOR_TOKEN__. Never edit core LAX to add an integration.
      - Do NOT ask questions — just build it based on the instructions
      - After writing files, output: APP_READY: <appUrl from the per-build context>

      WEBSITE-BUILD MODE — apply these rules:
      • NEVER use placeholder.com, lorem-picsum, unsplash random, or any external stock CDN. If real photos exist in the \`assets/\` folder of this app dir, USE THEM. If none exist, ask via the conversation rather than inventing placeholders.
      • NO TEXT WALLS. Hero needs a real image (not a color block) plus a short headline + sub + CTA. Each major section needs a visual anchor (photo, icon, or card). If a section has >60 words of body text without a visual, restructure it.
      • IMAGE DISCIPLINE. Every <img> gets explicit width/height OR aspect-ratio, object-fit: cover, loading="lazy", and max-width: 100%. Hero caps at 80vh. Photo grids force consistent ratios so portrait/landscape mix doesn't blow up the layout. Never let a native-resolution photo render at native size.
      • MOBILE FIRST. Default to mobile breakpoint, layer up to desktop with media queries. Use clamp() for fluid type and CSS grid/flex for layout.
      • HIERARCHY: Hero → social proof or photo grid → menu/services as cards → contact/CTA. Modern type scale, generous whitespace, color palette that fits the brand.
      • Light mode by default unless the brand source clearly uses dark.
      When the per-build context indicates a website request (or includes the WEBSITE-BUILD MODE rules), follow the rules above."
    `);
  });

  it("contains the static rules + WEBSITE_RULES content", () => {
    const out = renderPersonaPrompt();
    expect(out).toContain("App Builder agent");
    expect(out).toContain("APP_READY:");
    expect(out).toContain("WEBSITE-BUILD MODE");
    expect(out).toContain("IMAGE DISCIPLINE");
  });
});

describe("renderPerBuildContext — connector teaching reaches both build strategies", () => {
  // This lives in the per-build context (not the persona) on purpose: both the
  // cli-subprocess path and the in-canonical path render this, and it's
  // evaluated per build so it's never frozen at seed time. Regression for the
  // BTC dashboard that raw-fetched CoinGecko (CSP-blocked) because the builder
  // was never taught the connector escape hatch.
  it("tells the builder to use the connector proxy instead of a raw external fetch", () => {
    const out = renderPerBuildContext(SAMPLE_CREATE);
    expect(out).toContain("/api/connectors/<name>/<path>");
    expect(out).toContain("window.__LAX_CONNECTOR_TOKEN__");
    expect(out).toContain("connector_create tool");
    expect(out).toContain("must NOT edit core LAX");
  });
});

describe("native-build honesty rule reaches both build strategies", () => {
  // A Rust/Go/C app must run its real toolchain and never claim an unverified
  // JS-twin matches the real output. The rule lives in the persona (in-canonical
  // strategy) AND the per-build context (cli-subprocess strategy) so neither path
  // misses it. Regression for the raytracer that shipped a JS twin labeled
  // "identical to Rust output" without ever running cargo.
  it("persona carries the run-the-real-toolchain + no-unverified-parity rule", () => {
    const out = renderPersonaPrompt();
    expect(out).toContain("Actually build and RUN it with its real toolchain");
    expect(out).toContain("Never claim a preview");
  });

  it("per-build context carries the same rule (cli-subprocess path)", () => {
    const out = renderPerBuildContext(SAMPLE_CREATE);
    expect(out).toContain("Actually build and RUN it with its real toolchain");
    expect(out).toContain("Never claim a preview");
  });
});

describe("renderPerBuildContext — tier-specific RULES (the honest boundary)", () => {
  // quick-html (the default) must stay byte-identical to the pre-tier prompt —
  // already proven by the legacy-compose tests above (samples omit `tier`).
  it("quick-html (default) adds no tier block — no FULL-STACK or COMPILED mode", () => {
    const out = renderPerBuildContext(SAMPLE_CREATE);
    expect(out).not.toContain("FULL-STACK MODE");
    expect(out).not.toContain("COMPILED-LANGUAGE MODE");
  });

  it("full-stack tier instructs a real backend via the turnkey app_serve_backend primitive, not faked data", () => {
    const out = renderPerBuildContext({ ...SAMPLE_CREATE, tier: "full-stack" });
    expect(out).toContain("FULL-STACK MODE");
    expect(out).toContain('app_serve_backend({ app_id: "todo-app"');
    expect(out).toContain("cd server && npm install");   // command runs from app root → cd into the backend
    expect(out).toContain("/api/connectors/dev-todo-app/");
    expect(out).toContain("node:sqlite");                // built-in SQLite — no native compile to fail
    expect(out).toContain('"better-sqlite3": "latest"');  // if native, latest ships a prebuilt
    expect(out).toContain("NEVER pin an old version");     // the exact mistake that broke Grok's build
    // Class-general, not SQLite-only: other backends + other native modules.
    expect(out).toContain("pip install");                  // language-aware (Python backend, not just Node)
    expect(out).toContain("bcrypt");                       // names native offenders beyond better-sqlite3
    expect(out).toContain("VERIFIES it actually binds the port");  // the bind-or-fail backstop is taught
    expect(out).toContain("does a clean restart");                 // re-run app_serve_backend after backend edits
    expect(out).toContain("app_serve_frontend");                   // live Vite/Next dev-server path (desktop-first proxy)
    expect(out).toContain(`base to "/apps/todo-app/"`);            // the base-path config that makes the proxy resolve
    // The tier block sits right after the shared native rules.
    expect(out.indexOf("FULL-STACK MODE")).toBeGreaterThan(
      out.indexOf(NATIVE_BUILD_RULE_LINES[0]),
    );
  });

  it("compiled-native tier instructs running the real toolchain + a MINIMAL viewer, not a dashboard", () => {
    const out = renderPerBuildContext({ ...SAMPLE_CREATE, tier: "compiled-native" });
    expect(out).toContain("COMPILED-LANGUAGE MODE");
    expect(out).toContain("cargo run");
    expect(out).toContain("MINIMAL full-bleed VIEWER");
    // The dual-agent finding: a single render came out wrapped in dashboard
    // chrome. The prompt must explicitly forbid that shape.
    expect(out).toContain("NOT an app and NOT a dashboard");
    expect(out).toContain("NO cards, stats, headers");
    expect(out).not.toContain("FULL-STACK MODE");
  });

  it("compiled-native suppresses the 'edit the seeded starter' line (build_app skips the seed for it)", () => {
    const out = renderPerBuildContext({ ...SAMPLE_CREATE, tier: "compiled-native" });
    expect(out).not.toContain("An index.html starter + AGENTS.md have been seeded");
    // quick-html (the default) still seeds + tells the agent to edit the starter.
    expect(renderPerBuildContext(SAMPLE_CREATE)).toContain("An index.html starter + AGENTS.md have been seeded");
  });

  it("frontend-spa tier demands a REAL project + app_serve_frontend, forbids a static fake AND a production build", () => {
    const out = renderPerBuildContext({ ...SAMPLE_CREATE, tier: "frontend-spa" });
    expect(out).toContain("FRONTEND-SPA MODE");
    expect(out).toContain("app_serve_frontend");
    expect(out).toContain(`base path to "/apps/todo-app/"`);   // the proxy-resolving config
    // The live-Vite-fake failure: a static page that imitates the framework.
    expect(out).toContain("NOT a static HTML page");
    // The class both GPT-5.5 (vite build) and Grok (npm run lint) tripped on:
    // unnecessary post-scaffold tooling that errors and derails the finish.
    expect(out).toContain("Do NOT run any extra tooling");
    expect(out).toContain("no lint");
    expect(out).not.toContain("FULL-STACK MODE");
  });

  it("frontend-spa suppresses the seeded-starter line (no seed for it either)", () => {
    const out = renderPerBuildContext({ ...SAMPLE_CREATE, tier: "frontend-spa" });
    expect(out).not.toContain("An index.html starter + AGENTS.md have been seeded");
  });

  it("emits the path-quoting note ONLY when appDir contains a space (installed-app footgun)", () => {
    // Real failure: Grok ran `cd …/Local Agent X/… && npm i` unquoted → npm ran
    // in `…/Local` and couldn't find package.json.
    const spaced = { ...SAMPLE_CREATE, tier: "frontend-spa" as const, appDir: "/abs/Local Agent X/workspace/apps/todo-app" };
    const out = renderPerBuildContext(spaced);
    expect(out).toContain("contains SPACES");
    expect(out).toContain(`cd "/abs/Local Agent X/workspace/apps/todo-app"`);
    // A space-free dev-checkout path sees no quoting noise.
    expect(renderPerBuildContext({ ...SAMPLE_CREATE, tier: "frontend-spa" })).not.toContain("contains SPACES");
  });

  it("tier rule builders embed the app identifiers", () => {
    expect(fullStackRuleLines("notes", "/abs/apps/notes").join("\n")).toContain("dev-notes");
    expect(compiledRuleLines("/abs/apps/rt").join("\n")).toContain("/abs/apps/rt");
  });
});

describe("appBuilderPersonaRefresh — un-freezes a seed-frozen persona", () => {
  const FRESH = renderPersonaPrompt();

  // Regression: the template store seeds built-ins only on first run, so a
  // persona edit (e.g. the connector teaching) never reached an already-seeded
  // store — the builder ran a stale prompt. This is the decision the boot
  // migration uses to refresh it.
  it("returns the fresh persona when a seed-frozen built-in has drifted", () => {
    const stale = "You are the App Builder agent. (old persona without the new rules)";
    expect(appBuilderPersonaRefresh(stale, FRESH)).toBe(FRESH);
  });

  it("no-ops when the stored persona already matches code", () => {
    expect(appBuilderPersonaRefresh(FRESH, FRESH)).toBeNull();
  });

  it("leaves a fully-customized persona alone (built-in opener gone)", () => {
    const custom = "You are Bob, a bespoke app builder with house rules.";
    expect(appBuilderPersonaRefresh(custom, FRESH)).toBeNull();
  });
});
