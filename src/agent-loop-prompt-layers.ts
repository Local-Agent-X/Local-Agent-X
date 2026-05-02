// Per-attempt prompt layering.
//
// When a post-turn detector fires, its retry instruction needs to reach the
// model on the NEXT attempt. We do that by appending the instruction to the
// base system prompt for that attempt only — the base prompt stays
// untouched, and stale retry instructions don't leak into later attempts
// after the issue is resolved.
//
// Layering rules:
// - Instructions stack in priority order when multiple retries are active.
// - Each attempt reads the current instruction set; callers clear them when
//   the detector's condition no longer holds.
// - An "ack fast-path" instruction is a one-shot layer that gets set when
//   the user's latest message is a short approval ("ok", "do it", "go")
//   so the model skips recap and jumps to action.

import type { RetryInstruction } from "./agent-loop-detectors.js";

export interface PromptLayers {
  /** Most recent detector instruction (e.g. planning-only, empty-response) */
  retry?: RetryInstruction;
  /** User said "ok"/"do it"/"go" — skip plan recap */
  ackFastPath?: string;
  /** User asked for a website/landing page — fold in visual-first rules */
  websiteBuilder?: string;
}

export function createPromptLayers(): PromptLayers {
  return {};
}

/**
 * Build the effective system prompt for the next attempt by layering any
 * active retry/ack instructions on top of the base prompt.
 */
export function composeSystemPrompt(base: string, layers: PromptLayers): string {
  const additions: string[] = [];
  if (layers.websiteBuilder) additions.push(layers.websiteBuilder);
  if (layers.ackFastPath) additions.push(layers.ackFastPath);
  if (layers.retry) additions.push(layers.retry.instruction);
  if (additions.length === 0) return base;
  return `${base}\n\n---\n${additions.join("\n\n")}`;
}

// ── Ack fast-path detection ────────────────────────────────────────────────
//
// Short approval phrases in the user's latest message. When detected, the
// model gets an instruction to skip the "here's the plan" recap and go
// straight to the first concrete tool action.

const ACK_NORMALIZED = new Set<string>([
  "ok", "okay", "ok do it", "okay do it", "do it",
  "go", "go ahead", "please do", "please", "yes",
  "yep", "yup", "yeah", "sure", "sounds good",
  "sounds good do it", "ship it", "ship", "fix it",
  "make it so", "yes do it", "yep do it", "continue",
  "keep going", "go on", "proceed", "do that",
  "now what", "ok now what", "next", "whats next",
]);

export const ACK_FAST_PATH_INSTRUCTION =
  "The user's latest message is a short approval/continuation ('ok', 'do it', 'continue', etc). Do not recap the plan. Do not restate prior steps. Take the first concrete tool action immediately. Keep any user-facing follow-up brief and natural.";

/** Detect if the user's latest message is just an ack. */
export function isAckMessage(userText: string): boolean {
  const normalized = userText.trim().toLowerCase().replace(/[.!?,;]+$/, "");
  if (!normalized) return false;
  if (normalized.length > 40) return false;
  if (ACK_NORMALIZED.has(normalized)) return true;
  // Tolerate tiny variations: "ok let's go", "yes do it please"
  const firstFewWords = normalized.split(/\s+/).slice(0, 3).join(" ");
  if (ACK_NORMALIZED.has(firstFewWords)) return true;
  return false;
}

// ── Website-builder fast-path ──────────────────────────────────────────────
//
// When the user asks for a website/landing page (especially with source
// material like an Instagram URL, menu, or photos), inject hard rules that
// keep the build visual-first. Without these, both Codex and Anthropic
// default to a wall of <h1>/<p> with placeholder colors and oversized images.

const WEBSITE_NOUN_RE =
  /\b(website|web ?site|landing page|landing|home ?page|marketing ?page|micro ?site|one[- ]?pager|business site|biz site|menu page|portfolio|splash page)\b/i;

const BUILD_VERB_RE =
  /\b(build|create|make|design|spin up|put together|throw together|generate|scaffold|whip up|stand up|set up|redesign|rebuild|improve|level ?up)\b/i;

const SOURCE_ASSET_RE =
  /\b(instagram|insta\b|ig\b|@[a-z0-9._]+|menu|photos?|pictures?|images?|logo|screenshots?|brand(ing)?|gallery|facebook|fb\b|tiktok|yelp|google business)\b/i;

export const WEBSITE_BUILDER_INSTRUCTION =
  "WEBSITE-BUILD MODE — the user is asking for a site, landing page, or business page.\n\n" +
  "Hard rules (do not violate):\n" +
  "1. ASSET PIPELINE FIRST. Real images are non-negotiable.\n" +
  "   • If the user ATTACHED photos to the chat, copy each `[Attached file paths on disk]` into the app's `assets/` folder via `bash cp` (or read+write). NEVER ignore an attached photo. NEVER regenerate or substitute it.\n" +
  "   • If the user gave a SOURCE URL (Instagram handle, existing site, menu page), call `extract_site_assets` BEFORE writing HTML. For JS-rendered pages, fall back to the `browser` tool: navigate, then `evaluate` to collect image URLs.\n" +
  "   • Reference these local paths in the HTML — never `placeholder.com`, never lorem-picsum, never inline-only text.\n" +
  "2. NO TEXT WALLS. If a section has more than ~60 words of body copy without a visual (image, icon, card, photo), restructure it. Hero needs a real image. Each major section needs a visual anchor. If you genuinely have no images, generate a CSS gradient hero with bold typography — never a paragraph stack.\n" +
  "3. IMAGE DISCIPLINE. Every `<img>` gets explicit `width` + `height` (or `aspect-ratio`), `object-fit: cover`, `loading=\"lazy\"`, and a `max-width: 100%`. Hero images cap at 80vh. Photo grids use `object-fit: cover` so portrait/landscape mix doesn't blow up the layout. Never let a native-resolution image render at native size.\n" +
  "4. MOBILE FIRST + RESPONSIVE. Mobile breakpoint is the default. Desktop is the enhancement. Use CSS grid/flex, fluid typography (`clamp()`), and test the layout collapses cleanly.\n" +
  "5. VISUAL HIERARCHY. Hero (image + headline + sub + CTA) → social proof or photo grid → menu/services with cards → contact/CTA. No giant paragraph blocks.\n" +
  "6. SCREENSHOT-AND-CRITIQUE GATE. After the first build is on disk, take a screenshot of the rendered page (use the `browser` tool: navigate to the file URL or local server, then `screenshot`), call `view_image` on it, and self-critique against this checklist:\n" +
  "   • Is there a real hero image (not a color block)?\n" +
  "   • Are all images sized — no giants?\n" +
  "   • Is text-to-image balance reasonable in every section?\n" +
  "   • Does it collapse cleanly at mobile width?\n" +
  "   • Are real photos from the source visible (not placeholders)?\n" +
  "   Iterate at least once based on what you see. Report findings briefly, then fix.\n\n" +
  "If a `protocol_search` for `website-builder` returns a hit, call `protocol_get` on it to load the full template/checklist before scaffolding.";

/**
 * Detect if the user's latest message is asking for a website/landing page.
 * Triggers on a build verb + a site-shaped noun, OR a build verb + clear
 * source-asset signal (Instagram URL, menu, photos, brand). Conservative —
 * "build me a chat bot" or "build a tracker" don't fire.
 */
export function isWebsiteBuildIntent(userText: string): boolean {
  if (!userText) return false;
  const text = userText.toLowerCase();
  if (!BUILD_VERB_RE.test(text)) return false;
  if (WEBSITE_NOUN_RE.test(text)) return true;
  // Build verb + source-asset signal — covers "make a site from this Instagram"
  // even when the noun used is "site" alone (caught above) or implicit.
  // Require BOTH a build verb AND a source signal to avoid firing on
  // unrelated mentions of photos.
  if (SOURCE_ASSET_RE.test(text) && /\b(site|page|web)\b/.test(text)) return true;
  return false;
}
