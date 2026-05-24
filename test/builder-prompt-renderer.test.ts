/**
 * Pins the builder-prompt renderer extracted from builder-tools.ts in Phase 1
 * of docs/migration/build-app-to-canonical-op.md.
 *
 * The renderer is the single source of truth for both the legacy CLI-subprocess
 * path (today) and the canonical-op path (Phase 2). These tests guard the
 * byte-identical legacy output so the subprocess receives the exact same
 * prompt it did before the extraction.
 */
import { describe, it, expect } from "vitest";
import {
  renderBuilderPrompt,
  renderPersonaPrompt,
  renderPerBuildContext,
  looksLikeWebsiteRequest,
  WEBSITE_RULES_FRAGMENT,
  type BuilderPromptInput,
} from "../src/tools/render-builder-prompt.js";

// Mirrors the renderer's inline template. Keep this in sync only if the
// renderer changes intentionally — divergence here means we've changed the
// prompt the subprocess receives.
function legacyTemplate(input: BuilderPromptInput): string {
  const { appName, prompt, appDir, appUrl, isUpdate, contextFiles, assetFiles } = input;
  const isWebsite = looksLikeWebsiteRequest(prompt);
  const context = contextFiles.length > 0
    ? `\n\nExisting app context:\n${contextFiles.join("\n\n")}`
    : "";
  const assetManifest = assetFiles.length > 0
    ? `\n\nLOCAL ASSETS AVAILABLE (use these in <img src="..."> — relative to index.html):\n${assetFiles.map(p => `  - ${p}`).join("\n")}\n`
    : (isWebsite
        ? `\n\nNO LOCAL ASSETS YET. If the user mentioned a source URL or attached photos, the parent agent should have extracted them into assets/ before invoking you. Do NOT use placeholder.com or stock CDNs — instead, build a bold typography-driven hero with CSS gradients and ask in PROJECT.md for the photos to be added.\n`
        : "");
  const websiteRules = isWebsite ? WEBSITE_RULES_FRAGMENT : "";
  const starterLine = isUpdate
    ? ""
    : "- An index.html starter + AGENTS.md have been seeded — READ both, then EDIT index.html rather than rewriting it from scratch. Keep the inline-only CSP rule.\n";
  return `You are building a web app in the directory: ${appDir}
App name: ${appName}
Task: ${isUpdate ? "UPDATE existing app" : "CREATE new app"}

Environment:
- Files in this folder are served at: ${appUrl}
- The preview iframe enforces this CSP: script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: https: blob:; font-src 'self' data:; connect-src 'self'.
- External CDNs (Tailwind, jsdelivr, unpkg, Google Fonts) are blocked at the network layer. Inline or self-host.
- After write/edit, the preview reloads automatically; runtime errors are forwarded back to you in the next turn.
${context}${assetManifest}
Instructions: ${prompt}

RULES:
- Write ALL files to ${appDir}/ (use absolute paths)
- The main entry point MUST be index.html
${starterLine}- Create PROJECT.md with app description and status
- For single-page apps: put everything in index.html (inline CSS/JS is fine)
- Make it look polished — use modern CSS, good colors, responsive design
- The app will be served at ${appUrl}
- Do NOT ask questions — just build it based on the instructions
- After writing files, output: APP_READY: ${appUrl}
${websiteRules}`;
}

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
  appName: "nutrishop",
  prompt: "Build the Acme Springfield landing page — modern, photo-driven.",
  appDir: "/abs/workspace/apps/nutrishop",
  appUrl: "http://127.0.0.1:7007/apps/nutrishop/index.html",
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

describe("renderBuilderPrompt — byte-identical legacy compose", () => {
  it("create + no assets + non-website matches legacy literally", () => {
    expect(renderBuilderPrompt(SAMPLE_CREATE)).toBe(legacyTemplate(SAMPLE_CREATE));
  });

  it("update + context files + non-website matches legacy literally", () => {
    expect(renderBuilderPrompt(SAMPLE_UPDATE)).toBe(legacyTemplate(SAMPLE_UPDATE));
  });

  it("website + assets matches legacy literally", () => {
    expect(renderBuilderPrompt(SAMPLE_WEBSITE_WITH_ASSETS))
      .toBe(legacyTemplate(SAMPLE_WEBSITE_WITH_ASSETS));
  });

  it("website + no assets matches legacy literally (includes the 'no assets yet' callout)", () => {
    expect(renderBuilderPrompt(SAMPLE_WEBSITE_NO_ASSETS))
      .toBe(legacyTemplate(SAMPLE_WEBSITE_NO_ASSETS));
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

describe("renderPerBuildContext — matches the per-build prefix of the legacy template", () => {
  it("create case: per-build is the legacy template trimmed of its trailing website-rules slot", () => {
    const fullLegacy = legacyTemplate(SAMPLE_CREATE);
    // Legacy non-website tail is just "\n" (the literal `\n${websiteRules}` with
    // websiteRules=""). Per-build is everything before that final newline.
    expect(fullLegacy.endsWith("\n")).toBe(true);
    expect(renderPerBuildContext(SAMPLE_CREATE)).toBe(fullLegacy.slice(0, -1));
  });

  it("website case: per-build is the legacy template trimmed of '\\n' + WEBSITE_RULES_FRAGMENT", () => {
    const fullLegacy = legacyTemplate(SAMPLE_WEBSITE_WITH_ASSETS);
    const expectedTail = "\n" + WEBSITE_RULES_FRAGMENT;
    expect(fullLegacy.endsWith(expectedTail)).toBe(true);
    expect(renderPerBuildContext(SAMPLE_WEBSITE_WITH_ASSETS))
      .toBe(fullLegacy.slice(0, fullLegacy.length - expectedTail.length));
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
      - For single-page apps: put everything in index.html (inline CSS/JS is fine)
      - Make it look polished — use modern CSS, good colors, responsive design
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
