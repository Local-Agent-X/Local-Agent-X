/**
 * Builder-prompt rendering — lifted out of builder-tools.ts so both the legacy
 * CLI-subprocess path and the upcoming canonical-op path (Phase 2 of
 * docs/migration/build-app-to-canonical-op.md) render from the same source.
 *
 * Pure renderer at the top, fs-touching helpers at the bottom. The pure
 * functions take pre-read inputs only; the caller is responsible for any
 * disk reads (assets walk, existing-app context).
 */

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

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

export interface BuilderPromptInput {
  appName: string;
  prompt: string;
  appDir: string;
  appUrl: string;
  isUpdate: boolean;
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

  const context = contextFiles.length > 0
    ? `\n\nExisting app context:\n${contextFiles.join("\n\n")}`
    : "";

  const assetManifest = assetFiles.length > 0
    ? `\n\nLOCAL ASSETS AVAILABLE (use these in <img src="..."> — relative to index.html):\n${assetFiles.map(p => `  - ${p}`).join("\n")}\n`
    : (isWebsite
        ? `\n\nNO LOCAL ASSETS YET. If the user mentioned a source URL or attached photos, the parent agent should have extracted them into assets/ before invoking you. Do NOT use placeholder.com or stock CDNs — instead, build a bold typography-driven hero with CSS gradients and ask in PROJECT.md for the photos to be added.\n`
        : "");

  return `You are building a web app in the directory: ${appDir}
App name: ${appName}
Task: ${isUpdate ? "UPDATE existing app" : "CREATE new app"}
${context}${assetManifest}
Instructions: ${prompt}

RULES:
- Write ALL files to ${appDir}/ (use absolute paths)
- The main entry point MUST be index.html
- Create PROJECT.md with app description and status
- For single-page apps: put everything in index.html (inline CSS/JS is fine)
- Make it look polished — use modern CSS, good colors, responsive design
- The app will be served at ${appUrl}
- Do NOT ask questions — just build it based on the instructions
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
    "- For single-page apps: put everything in index.html (inline CSS/JS is fine)",
    "- Make it look polished — use modern CSS, good colors, responsive design",
    "- Do NOT ask questions — just build it based on the instructions",
    "- After writing files, output: APP_READY: <appUrl from the per-build context>",
    WEBSITE_RULES_FRAGMENT +
      "When the per-build context indicates a website request (or includes the WEBSITE-BUILD MODE rules), follow the rules above.",
  ].join("\n");
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
 * Read the standard update-context files (PROJECT.md, TODO.md, index.html)
 * from an existing app dir, formatted as `=== FILE ===\n<contents>` blocks
 * truncated at 3KB each. Returns [] if no files exist.
 */
export function readUpdateContextFiles(appDir: string): string[] {
  const blocks: string[] = [];
  for (const f of ["PROJECT.md", "TODO.md", "index.html"]) {
    const p = join(appDir, f);
    if (existsSync(p)) {
      try { blocks.push(`=== ${f} ===\n${readFileSync(p, "utf-8").slice(0, 3000)}`); } catch { /* skip */ }
    }
  }
  return blocks;
}
