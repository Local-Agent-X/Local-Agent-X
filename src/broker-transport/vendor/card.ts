// A card the agent showed the user (LAX src/tools/show-card.ts): one image, a title, a
// few short facts and links, drawn in the chat on the desktop and the phone alike. The
// desktop puts it on the tool call's result metadata (`metadata.card`), on the live
// `tool_end` and on the tool events of a reloaded history, and sends it on a voice call
// as the `card` event (voice.ts), since a call's reply is spoken.

import { asRecord, asString } from "./guards.js";

export type ChatCard = {
  title: string;
  subtitle?: string;
  /** The image as the desktop serves it, an /images/... path. */
  image?: string;
  facts?: Array<{ label: string; value: string }>;
  /** Links the user may open; opening one only opens the page. */
  links?: Array<{ label: string; url: string }>;
  /** The site the details came from. */
  source?: string;
};

const WEB = /^https?:\/\//i;

/** A card, or null when `raw` is not one. A link that is not a web address, or an image
 *  that is not one of the desktop's /images paths, is left out. */
export function parseCard(raw: unknown): ChatCard | null {
  const r = asRecord(raw);
  const title = asString(r?.title);
  if (r === null || title === null || title === "") return null;
  const card: ChatCard = { title };
  const subtitle = asString(r.subtitle);
  if (subtitle) card.subtitle = subtitle;
  const image = asString(r.image);
  if (image !== null && image.startsWith("/images/") && !image.includes("..")) card.image = image;
  const facts = (Array.isArray(r.facts) ? r.facts : []).flatMap((f) => {
    const o = asRecord(f);
    const label = asString(o?.label);
    const value = asString(o?.value);
    return label && value ? [{ label, value }] : [];
  });
  if (facts.length > 0) card.facts = facts;
  const links = (Array.isArray(r.links) ? r.links : []).flatMap((l) => {
    const o = asRecord(l);
    const label = asString(o?.label);
    const url = asString(o?.url);
    return label && url && WEB.test(url) ? [{ label, url }] : [];
  });
  if (links.length > 0) card.links = links;
  const source = asString(r.source);
  if (source) card.source = source;
  return card;
}

/** The card in a tool result's metadata, or null when it carries none. */
export function parseCardMetadata(metadata: unknown): ChatCard | null {
  return parseCard(asRecord(metadata)?.card);
}
