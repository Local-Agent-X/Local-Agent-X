/**
 * show_card — the agent shows the user a card in the chat: one image, a title, a few
 * short facts and links. A product with its price and a link to the store, a recipe,
 * a place with directions, a person, a news story. On a voice call it is shown, not
 * spoken: the agent says "here are three" and the cards appear in the chat. The same
 * card draws in the desktop chat and on the phone, live and from history, because it
 * rides the tool result's `metadata.card` (persisted with the tool row like any
 * result metadata) and a call forwards it (server/voice-ws.ts).
 *
 * The image is the one thing fetched off this computer. It goes through the hardened
 * egress path (canonicalFetch: SSRF pin, redirect re-checks, the strict allowlist)
 * and is saved under the workspace's images/cards, served as /images/cards/<file>
 * like every image the chat shows, so a client never contacts the image's host and
 * the phone reaches it through the paths its tunnel already allows. Only raster
 * images (no SVG, which is a document), at most 5 MB, cached by the URL's hash. A
 * card whose image cannot be fetched still shows, without it.
 *
 * Nothing fetched reaches the model: the result is only that the card was shown.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

import type { ToolDefinition, ToolResult } from "../types.js";
import { getRuntimeConfig } from "../config.js";
import { canonicalFetch } from "./web-egress.js";
import { confineToDir } from "../security/layer/index.js";
import { createLogger } from "../logger.js";

const logger = createLogger("tools.show-card");

/** A card as the clients draw it (metadata.card; agentxos chat.ts ChatCard). */
export interface ShowCard {
  title: string;
  subtitle?: string;
  /** A served path, /images/... */
  image?: string;
  facts?: Array<{ label: string; value: string }>;
  links?: Array<{ label: string; url: string }>;
  source?: string;
}

const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const IMAGE_EXT: Record<string, string> = { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp", "image/gif": "gif" };
const MAX_FACTS = 4;
const MAX_LINKS = 3;

const text = (v: unknown, max: number): string => (typeof v === "string" ? v.trim().slice(0, max) : "");

function webUrl(v: unknown): string | null {
  if (typeof v !== "string") return null;
  try {
    const u = new URL(v.trim());
    return u.protocol === "https:" || u.protocol === "http:" ? u.href : null;
  } catch {
    return null;
  }
}

/** Where card images are saved, and the folder /images/ serves. */
function imagesDir(): string {
  return resolve(getRuntimeConfig().workspace, "images");
}

/** The image as a served /images path: an existing one passes through, a web URL is
 *  fetched and saved. Throws with the reason a card goes without it. */
export async function cardImage(source: string, fetchImage: typeof canonicalFetch = canonicalFetch): Promise<string> {
  if (source.startsWith("/images/")) {
    // The same confinement /images/ is served with (server/static-assets.ts).
    const file = confineToDir(imagesDir(), source.slice("/images/".length));
    if (file === null || !existsSync(file)) throw new Error(`no such image: ${source}`);
    return source;
  }
  const url = webUrl(source);
  if (url === null) throw new Error("the image is not a web address or an /images path");
  const name = createHash("sha256").update(url).digest("hex").slice(0, 24);
  const dir = join(imagesDir(), "cards");
  for (const ext of Object.values(IMAGE_EXT)) {
    if (existsSync(join(dir, `${name}.${ext}`))) return `/images/cards/${name}.${ext}`;
  }
  const res = await fetchImage(url, { headers: { Accept: "image/*" }, timeoutMs: 10_000 });
  if (!res.ok) throw new Error(`the image host answered ${res.status}`);
  const type = (res.headers.get("content-type") ?? "").split(";")[0]!.trim().toLowerCase();
  const ext = IMAGE_EXT[type];
  if (ext === undefined) throw new Error(`not a picture the chat shows (${type || "no type"})`);
  const declared = Number(res.headers.get("content-length") ?? 0);
  if (declared > MAX_IMAGE_BYTES) throw new Error("the image is over 5 MB");
  const bytes = Buffer.from(await res.arrayBuffer());
  if (bytes.length > MAX_IMAGE_BYTES) throw new Error("the image is over 5 MB");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${name}.${ext}`), bytes);
  return `/images/cards/${name}.${ext}`;
}

/** The card the arguments describe, without its image; null when it has no title. */
export function cardOf(args: Record<string, unknown>): ShowCard | null {
  const title = text(args.title, 120);
  if (!title) return null;
  const card: ShowCard = { title };
  const subtitle = text(args.subtitle, 160);
  if (subtitle) card.subtitle = subtitle;
  const facts = (Array.isArray(args.facts) ? args.facts : []).flatMap((f) => {
    const o = (f ?? {}) as Record<string, unknown>;
    const label = text(o.label, 40);
    const value = text(o.value, 80);
    return label && value ? [{ label, value }] : [];
  }).slice(0, MAX_FACTS);
  if (facts.length > 0) card.facts = facts;
  const links = (Array.isArray(args.links) ? args.links : []).flatMap((l) => {
    const o = (l ?? {}) as Record<string, unknown>;
    const label = text(o.label, 40);
    const url = webUrl(o.url);
    return label && url ? [{ label, url }] : [];
  }).slice(0, MAX_LINKS);
  if (links.length > 0) card.links = links;
  const source = text(args.source, 60);
  if (source) card.source = source;
  return card;
}

export const showCardTool: ToolDefinition = {
  name: "show_card",
  compactDescription: "Show the user a card in the chat: one image, title, up to 4 short facts, up to 3 links. On a voice call it is shown, not spoken. One card per item.",
  description:
    "Show the user a card in the chat: one image, a title, an optional subtitle, up to 4 short facts (price, rating, time, " +
    "distance) and up to 3 links (store page, recipe, directions, article), with the source site. Use it whenever a picture " +
    "or a link helps more than words: products to compare, a recipe, a place, a person, a news story, a result you found. " +
    "One card per item; call it once for each of a few options. On a voice call the card is SHOWN, not spoken: say briefly " +
    "what you are showing ('here are three gliders') and don't read the card's details aloud. `image` is the image's web " +
    "address (from the page you found it on) or an /images path you made; the desktop fetches and keeps it. Links only " +
    "open pages: showing a store link never buys anything.",
  parameters: {
    type: "object",
    properties: {
      title: { type: "string", description: "What the card is about (a product name, a recipe, a place)." },
      subtitle: { type: "string", description: "One short line under the title." },
      image: { type: "string", description: "The image: its https address, or an /images/... path." },
      facts: {
        type: "array",
        description: "Up to 4 short label/value pairs, e.g. {label:'Price', value:'$189'}.",
        items: { type: "object", properties: { label: { type: "string" }, value: { type: "string" } }, required: ["label", "value"] },
      },
      links: {
        type: "array",
        description: "Up to 3 links, e.g. {label:'View on Amazon', url:'https://...'}.",
        items: { type: "object", properties: { label: { type: "string" }, url: { type: "string" } }, required: ["label", "url"] },
      },
      source: { type: "string", description: "The site the card's details came from, e.g. 'amazon.com'." },
    },
    required: ["title"],
  },
  async execute(args): Promise<ToolResult> {
    const card = cardOf(args);
    if (card === null) return { content: "show_card needs a title.", isError: true };
    let note = "";
    if (typeof args.image === "string" && args.image.trim()) {
      try {
        card.image = await cardImage(args.image.trim());
      } catch (e) {
        note = ` (without its image: ${(e as Error).message})`;
        logger.info(`[show_card] "${card.title}" shown without its image: ${(e as Error).message}`);
      }
    }
    return { content: `Shown to the user as a card: "${card.title}"${note}.`, metadata: { card } };
  },
};
