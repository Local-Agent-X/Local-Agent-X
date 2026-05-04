/**
 * Vision pre-extract — pull visible brand names, project names, domain
 * names, and distinctive entities out of an attached image so the
 * orchestrator's auto-recall trigger can fire on image content.
 *
 * Provider: bypasses Anthropic CLI (which strips images to "[User attached
 * 1 image]" placeholder text — the bug that made earlier tests return
 * empty). Uses direct multimodal HTTP. Order:
 *   1. OpenAI gpt-4o (most reliable vision, present whenever the user has
 *      Codex / OpenAI configured — same provider their main agent runs on)
 *   2. Anthropic API key (sk-ant-api03-*) — direct API supports images
 *      properly. Skipped on OAuth-only auth (CLI strips images).
 *
 * Returns null on any failure → caller falls back to typed-text-only
 * recall pipeline (no behavior regression).
 */

import { readFileSync, existsSync } from "node:fs";
import { extname } from "node:path";
import { createLogger } from "../logger.js";
import { loadAnthropicTokens, isAnthropicTokenExpired } from "../auth-anthropic.js";

const logger = createLogger("classifier.vision-extract");
const TIMEOUT_MS = 6000;

const SYSTEM_PROMPT = `You extract every distinctive piece of named text visible in an image so a downstream agent can recall prior context. Be GENEROUS — include anything a user might have typed as a project name, brand, domain, person, business, app, file, or label.

Reply with EXACTLY a single JSON object:
{"entities": ["<entity1>", "<entity2>"]}

What to include (be inclusive):
- Brand names, logos, wordmarks ("Baddies & Sugar Daddies", "ScanProgress", "Kraken")
- Domain names visible anywhere ("baddiesandsugardaddies.com", "scanprogress.io")
- Product / app / feature names
- People's names, business names, headings, titles
- Any prominent label / tagline that could be a project identifier
- Slugs visible in URLs, filenames, breadcrumbs

What to skip:
- Generic descriptions ("a car", "a button", "blue background") — those aren't names
- Obvious dummy text ("Lorem ipsum", "Sample Text", "Your Name Here")
- UI chrome from common apps unless the app's brand IS the entity (skip "File / Edit / View"; KEEP "Notion" if "Notion" is in the screenshot)

Format:
- Cap at 8 entries.
- Use the visible spelling exactly (preserve capitalization, hyphens, "&" symbols, etc.).
- If you genuinely see no distinctive named text — pure photo of a person, untyped sketch, blank screen — reply {"entities": []}. But if there is ANY readable brand/word/title in the image, include it.
- No fences, no prose, just the JSON.`;

const USER_PROMPT = "Extract every distinctive named entity visible in this image. Reply with the JSON object only.";

export interface VisionEntityResult {
  entities: string[];
}

export async function extractEntitiesFromImage(
  imagePathOrUrl: string,
  opts?: { signal?: AbortSignal; timeoutMs?: number },
): Promise<VisionEntityResult | null> {
  let dataUrl: string;
  try {
    dataUrl = await loadAsDataUrl(imagePathOrUrl);
  } catch (e) {
    logger.warn(`load failed: ${(e as Error).message}`);
    return null;
  }

  const timeoutMs = opts?.timeoutMs ?? TIMEOUT_MS;
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  const linkedSignal = opts?.signal ? linkAbortSignals(opts.signal, ac.signal) : ac.signal;

  try {
    // Try OpenAI first — most users with Codex/gpt-5.5 selected have this.
    const openaiResult = await tryOpenAI(dataUrl, linkedSignal);
    if (openaiResult !== null) return logResult(imagePathOrUrl, openaiResult);

    // Fallback to Anthropic API key (sk-ant-api03-*). OAuth/CLI tokens are
    // skipped because the CLI proxy strips images.
    const anthropicResult = await tryAnthropicDirect(dataUrl, linkedSignal);
    if (anthropicResult !== null) return logResult(imagePathOrUrl, anthropicResult);

    logger.info("no vision-capable provider available — skipping pre-extract");
    return null;
  } finally {
    clearTimeout(timer);
  }
}

function logResult(imagePathOrUrl: string, result: VisionEntityResult): VisionEntityResult {
  const fname = imagePathOrUrl.split(/[\\/]/).pop();
  if (result.entities.length === 0) {
    logger.info(`extracted 0 entities from ${fname}`);
  } else {
    logger.info(`extracted ${result.entities.length} entities from ${fname}: ${result.entities.slice(0, 4).join(", ")}`);
  }
  return result;
}

async function tryOpenAI(dataUrl: string, signal: AbortSignal): Promise<VisionEntityResult | null> {
  const apiKey = process.env.OPENAI_API_KEY || "";
  if (!apiKey) return null;
  try {
    const res = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        model: "gpt-4o",
        temperature: 0,
        max_tokens: 300,
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          {
            role: "user",
            content: [
              { type: "text", text: USER_PROMPT },
              { type: "image_url", image_url: { url: dataUrl } },
            ],
          },
        ],
      }),
      signal,
    });
    if (!res.ok) {
      logger.warn(`openai vision HTTP ${res.status}`);
      return null;
    }
    const data = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
    const raw = data.choices?.[0]?.message?.content || "";
    return parseEntities(raw);
  } catch (e) {
    const msg = (e as Error).message || "";
    if (!msg.includes("aborted")) logger.warn(`openai vision call failed: ${msg}`);
    return null;
  }
}

async function tryAnthropicDirect(dataUrl: string, signal: AbortSignal): Promise<VisionEntityResult | null> {
  // Need a real API key (sk-ant-api03-*). OAuth tokens go through the CLI
  // which strips images — useless for vision.
  let apiKey = process.env.ANTHROPIC_API_KEY || "";
  if (!apiKey) {
    const tokens = loadAnthropicTokens();
    if (tokens && !isAnthropicTokenExpired(tokens) && tokens.accessToken?.startsWith("sk-ant-api")) {
      apiKey = tokens.accessToken;
    }
  }
  if (!apiKey || !apiKey.startsWith("sk-ant-api")) return null;

  // Convert data URL to base64+media-type for Anthropic's native format.
  const m = dataUrl.match(/^data:([^;]+);base64,(.+)$/);
  if (!m) return null;
  const [, mediaType, b64] = m;

  try {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "anthropic-version": "2023-06-01",
        "x-api-key": apiKey,
      },
      body: JSON.stringify({
        model: "claude-sonnet-4-6",
        max_tokens: 300,
        temperature: 0,
        system: SYSTEM_PROMPT,
        messages: [
          {
            role: "user",
            content: [
              { type: "image", source: { type: "base64", media_type: mediaType, data: b64 } },
              { type: "text", text: USER_PROMPT },
            ],
          },
        ],
      }),
      signal,
    });
    if (!res.ok) {
      logger.warn(`anthropic vision HTTP ${res.status}`);
      return null;
    }
    const data = (await res.json()) as { content?: Array<{ text?: string }> };
    const raw = data.content?.[0]?.text || "";
    return parseEntities(raw);
  } catch (e) {
    const msg = (e as Error).message || "";
    if (!msg.includes("aborted")) logger.warn(`anthropic vision call failed: ${msg}`);
    return null;
  }
}

function parseEntities(raw: string): VisionEntityResult | null {
  const cleaned = raw.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```\s*$/i, "").trim();
  if (!cleaned) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(cleaned);
  } catch {
    logger.warn(`unparseable vision response: "${cleaned.slice(0, 200)}"`);
    return null;
  }
  const arr = (parsed as { entities?: unknown }).entities;
  if (!Array.isArray(arr)) return null;
  const entities = arr
    .map((v) => (typeof v === "string" ? v.trim() : ""))
    .filter((s) => s.length > 1 && s.length < 80)
    .slice(0, 8);
  return { entities };
}

async function loadAsDataUrl(pathOrUrl: string): Promise<string> {
  if (/^data:/i.test(pathOrUrl)) return pathOrUrl;
  if (/^https?:\/\//i.test(pathOrUrl)) {
    // Inline-fetch the image so providers that don't support remote URLs
    // (Anthropic native expects base64) still work uniformly.
    const res = await fetch(pathOrUrl);
    if (!res.ok) throw new Error(`http ${res.status} fetching image`);
    const buf = Buffer.from(await res.arrayBuffer());
    const mime = res.headers.get("content-type") || "image/png";
    return `data:${mime};base64,${buf.toString("base64")}`;
  }
  if (!existsSync(pathOrUrl)) throw new Error(`image file not found: ${pathOrUrl}`);
  const ext = extname(pathOrUrl).toLowerCase();
  const mimeMap: Record<string, string> = {
    ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
    ".gif": "image/gif", ".webp": "image/webp",
  };
  const mime = mimeMap[ext] || "image/png";
  const b64 = readFileSync(pathOrUrl).toString("base64");
  return `data:${mime};base64,${b64}`;
}

function linkAbortSignals(a: AbortSignal, b: AbortSignal): AbortSignal {
  const ac = new AbortController();
  const onAbort = () => ac.abort();
  if (a.aborted || b.aborted) ac.abort();
  else {
    a.addEventListener("abort", onAbort, { once: true });
    b.addEventListener("abort", onAbort, { once: true });
  }
  return ac.signal;
}
