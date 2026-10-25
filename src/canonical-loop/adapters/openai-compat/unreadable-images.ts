/**
 * An image the model's runtime cannot load costs the image, never the turn.
 *
 * A tool result can carry an image the runtime refuses: a PNG the model wrote
 * by hand and opened with view_image, a corrupt download, a format the runtime
 * does not read. Ollama answers the whole request with 400 "Failed to load
 * image or audio file", and the op ended on that transport error, mid-task
 * (gcode-to-text, 2026-10-25). The image also stayed in history, so every
 * later turn would have been refused the same way.
 *
 * On that refusal the newest images are left out, the model is told in their
 * place, and the request is sent again; if the runtime still refuses, every
 * image is left out. Left-out images are remembered by content for the rest
 * of the adapter's life, so later turns never send them. op_messages keeps
 * them: only the wire request changes.
 */
import { createHash } from "node:crypto";
import type { ChatCompletionMessageParam } from "openai/resources/chat/completions.js";
import type { AdapterReport } from "../../adapter-contract.js";
import type { ProviderRequest } from "../../../providers/adapter/types.js";
import { createLogger } from "../../../logger.js";
import type { StreamOnceResult } from "./types.js";

const logger = createLogger("canonical-loop.adapters.openai-compat.images");

/** The runtimes' "this image cannot be loaded" phrasings, and only those: Ollama
 *  and llama.cpp, vLLM (PIL), and OpenAI-compatible servers. */
export function isImageRejection(message: string | undefined): boolean {
  return /failed to load image|cannot identify image file|invalid image|image (?:could not|cannot) be (?:decoded|processed|read)/i.test(message ?? "");
}

type ContentPart = { type: string; text?: string; image_url?: { url: string } };

const keyOf = (url: string) => createHash("sha256").update(url).digest("hex");

function imageUrlsIn(message: ChatCompletionMessageParam): string[] {
  if (!Array.isArray(message.content)) return [];
  return (message.content as ContentPart[]).flatMap((p) => (p.type === "image_url" && p.image_url ? [p.image_url.url] : []));
}

/** The request with every image in `unreadable` replaced by a note to the model. */
export function withoutUnreadableImages(req: ProviderRequest, unreadable: ReadonlySet<string>, reason: string): ProviderRequest {
  if (unreadable.size === 0) return req;
  const note = `[An image here could not be read by the model runtime (${reason}) and was left out. If you made the file, it is probably not a valid image.]`;
  const messages = req.messages.map((m) => {
    if (!Array.isArray(m.content)) return m;
    const parts = m.content as ContentPart[];
    const kept = parts.filter((p) => !(p.type === "image_url" && p.image_url && unreadable.has(keyOf(p.image_url.url))));
    if (kept.length === parts.length) return m;
    return { ...m, content: [...kept, { type: "text", text: note }] } as ChatCompletionMessageParam;
  });
  return { ...req, messages };
}

/**
 * Send `req` through `send`, leaving out what the runtime cannot load. The
 * failed attempt's error report is held back while a retry can still succeed,
 * so the turn loop never sees an error the retry recovered from.
 */
export async function sendLeavingOutUnreadableImages(
  req: ProviderRequest,
  report: (r: AdapterReport) => void,
  send: (req: ProviderRequest, report: (r: AdapterReport) => void) => Promise<StreamOnceResult>,
  unreadable: Set<string>,
): Promise<StreamOnceResult> {
  let reason = "an earlier request refused it";
  let current = withoutUnreadableImages(req, unreadable, reason);
  for (let attempt = 0; ; attempt++) {
    const held: AdapterReport[] = [];
    const result = await send(current, (r) => (r.kind === "error" ? held.push(r) : report(r)));
    const withImages = current.messages.filter((m) => imageUrlsIn(m).length > 0);
    if (attempt === 2 || !isImageRejection(result.firstError?.message) || withImages.length === 0) {
      for (const r of held) report(r);
      return result;
    }
    // First the newest images (the ones the last accepted request did not
    // carry); if that is not enough, all of them.
    const leftOut = attempt === 0 ? imageUrlsIn(withImages[withImages.length - 1]) : withImages.flatMap(imageUrlsIn);
    for (const url of leftOut) unreadable.add(keyOf(url));
    reason = result.firstError?.message ?? reason;
    logger.warn(`runtime refused ${leftOut.length} image(s) ("${reason}") — leaving them out and sending again`);
    current = withoutUnreadableImages(current, unreadable, reason);
  }
}
