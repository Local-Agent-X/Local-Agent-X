// Bounded revival of image attachments carried on seeded history rows.
// SHARED by the two seeding seams — chat-runner/seed-messages.ts and
// agent-runner/seed-messages.ts — so the revival policy (caps, most-recent
// dedupe, placeholder wording) lives in exactly ONE place. Do not fork a
// second copy; import from here.
//
// Reviving a photo from session history makes its bytes ride EVERY request
// for as long as the row stays inside the history keep-window (40 web / 30
// bridge rows) — an unbounded revival turns one oversized upload into a
// poisoned window where every request, including text-only asks, 400s on the
// provider's per-image cap for ~20 turns. So revival is bounded HERE:
//   - bytes only for the MOST RECENT occurrence of each unique image url,
//   - at most REVIVED_HISTORY_IMAGE_MAX_COUNT unique images per request,
//   - each at most REVIVED_HISTORY_IMAGE_MAX_BYTES (statted BEFORE any read),
// and every older/excess/oversized occurrence degrades to a short text
// placeholder so the model still knows an image was there. The CURRENT
// message's first-send images are deliberately not gated — that
// unconditional read predates this seam.

import { statSync } from "node:fs";
import type { ChatCompletionMessageParam } from "openai/resources/chat/completions.js";
import { mapUploadsRef } from "../workspace/paths.js";

export const REVIVED_HISTORY_IMAGE_MAX_COUNT = 6;
export const REVIVED_HISTORY_IMAGE_MAX_BYTES = 4 * 1024 * 1024;

export type HistoryImage = { name: string; url: string; filePath?: string };

/** A user row's `images` prop, normalized: url required, same-row exact
 *  duplicates collapsed, filePath restored from the "/uploads/<f>" url via
 *  mapUploadsRef — the SAME single-source mapping file tools and the
 *  security gate resolve attachment refs with. */
export function historyImagesOf(msg: ChatCompletionMessageParam): HistoryImage[] {
  const raw = (msg as ChatCompletionMessageParam & { images?: unknown }).images;
  if (!Array.isArray(raw)) return [];
  const out: HistoryImage[] = [];
  const seen = new Set<string>();
  for (const im of raw) {
    if (!im || typeof im !== "object") continue;
    const url = String((im as { url?: unknown }).url ?? "");
    if (!url || seen.has(url)) continue;
    seen.add(url);
    const name = String((im as { name?: unknown }).name ?? "");
    const stored = (im as { filePath?: unknown }).filePath;
    const filePath =
      typeof stored === "string" && stored ? stored : mapUploadsRef(url) ?? undefined;
    out.push({ name, url, ...(filePath ? { filePath } : {}) });
  }
  return out;
}

/** Decoded byte size of the image, or null when it cannot be statted — a
 *  null flows through so the shared converter emits its standard
 *  unreadable-attachment note (the single surfacer for that failure). */
function imageByteSize(img: HistoryImage): number | null {
  if (img.url.startsWith("data:")) {
    const b64 = img.url.slice(img.url.indexOf(",") + 1);
    return Math.floor((b64.length * 3) / 4);
  }
  if (!img.filePath) return null;
  try {
    return statSync(img.filePath).size;
  } catch {
    return null;
  }
}

/** rowIdx → urls that get real bytes at that row. Most recent unique urls
 *  win the budget; a url repeated across rows revives only at its LAST row.
 *  Only `role:"user"` rows carry revivable images — both seeders' role
 *  mappers send exactly that role to canonical "user". */
export function buildRevivalPlan(history: readonly ChatCompletionMessageParam[]): Map<number, Set<string>> {
  const lastRowOf = new Map<string, number>();
  history.forEach((msg, i) => {
    if (msg.role !== "user") return;
    for (const img of historyImagesOf(msg)) lastRowOf.set(img.url, i);
  });
  const plan = new Map<number, Set<string>>();
  let budget = REVIVED_HISTORY_IMAGE_MAX_COUNT;
  for (let i = history.length - 1; i >= 0 && budget > 0; i--) {
    const msg = history[i];
    if (msg.role !== "user") continue;
    for (const img of historyImagesOf(msg)) {
      if (budget <= 0) break;
      if (lastRowOf.get(img.url) !== i) continue;
      let set = plan.get(i);
      if (!set) {
        set = new Set();
        plan.set(i, set);
      }
      set.add(img.url);
      budget -= 1;
    }
  }
  return plan;
}

/** Apply the plan to one row's images: winners get real bytes back (the
 *  shared converter re-reads them per request, or emits its standard
 *  unreadable-attachment note for a pruned upload); every older/excess/
 *  oversized occurrence becomes a text placeholder so the row still
 *  survives, non-empty, without ballooning every request. */
export function reviveRowImages(
  all: readonly HistoryImage[],
  reviveUrls: ReadonlySet<string> | undefined,
): { images?: HistoryImage[]; placeholderText: string } {
  const revived: HistoryImage[] = [];
  const placeholders: string[] = [];
  for (const img of all) {
    const label = img.name || "image";
    if (!reviveUrls || !reviveUrls.has(img.url)) {
      placeholders.push(`[Image ${label} shown earlier in this conversation]`);
      continue;
    }
    const size = imageByteSize(img);
    if (size !== null && size > REVIVED_HISTORY_IMAGE_MAX_BYTES) {
      placeholders.push(`[Image ${label} omitted from history: too large to resend]`);
      continue;
    }
    revived.push({ name: img.name, url: img.url, ...(img.filePath ? { filePath: img.filePath } : {}) });
  }
  return {
    ...(revived.length > 0 ? { images: revived } : {}),
    placeholderText: placeholders.join("\n"),
  };
}
