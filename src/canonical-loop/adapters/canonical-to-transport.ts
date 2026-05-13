/**
 * Provider-agnostic CanonicalMessage[] → TransportMessage[] conversion.
 *
 * Every adapter (anthropic, codex, and any future addition) needs to take
 * the canonical loop's role-tagged op_messages and reshape them into the
 * TransportMessage envelope that adapters' transports consume. Doing
 * that conversion *inside each adapter* meant:
 *
 *   - The same logic existed twice (anthropic.ts + codex.ts had near-
 *     identical convertMessages functions).
 *   - When the seed path started persisting `content.toolCalls` on
 *     assistant rows so tool-using histories survive a chat resume,
 *     each adapter had to learn to read that field independently.
 *     The Codex adapter learned it; the Anthropic adapter did not, and
 *     Anthropic chats with tool-using history would have hit the same
 *     "orphan tool_result" rejection eventually.
 *
 * Promoting the conversion to a shared helper means every adapter gets
 * the same round-trip semantics for free. New adapters just import this
 * helper; their adapter-specific code is the thin shell that hands
 * TransportMessage[] to whichever transport they wrap.
 *
 * Rules encoded here:
 *   - "system" / "user" canonical rows pass through unchanged (text only).
 *   - "assistant" rows pass through their text AND any toolCalls they
 *     carry on `content.toolCalls`. Adapters whose transport translates
 *     toolCalls into the provider's tool_use shape get them automatically.
 *   - "tool_result" rows become role:"tool" with toolCallId pulled from
 *     `content.toolCallId`; the result body is a string (JSON-stringified
 *     when not already a string).
 *   - "control" rows (rare; redirect/system-injection markers) become
 *     user messages with a `[CONTROL] ` prefix.
 *   - A pendingRedirect (turn-boundary user message from the redirect
 *     control API) is appended as a user message with a `[REDIRECT] `
 *     prefix.
 *
 * Anything that's adapter-SPECIFIC (e.g. Codex's compound call_id|item_id
 * encoding inside transport→provider conversion) stays inside that
 * adapter's own files. This helper draws the line at "canonical →
 * transport" — provider wire format conversion is the next layer down.
 */
import type { CanonicalMessage } from "../contract-types.js";
import type { TurnInput } from "../adapter-contract.js";
import type { TransportMessage } from "./anthropic.js";
import { sanitizeAssistantTextForRebuild } from "../../anthropic-client/parse.js";
import { createLogger } from "../../logger.js";

const sanitizerLogger = createLogger("canonical-loop.rebuild-sanitizer");

export function canonicalToTransport(
  messages: CanonicalMessage[],
  pendingRedirect: TurnInput["pendingRedirect"],
  validToolNames?: ReadonlySet<string>,
): TransportMessage[] {
  const out: TransportMessage[] = [];
  for (const m of messages) {
    const c = m.content as Record<string, unknown> | string | null | undefined;
    if (m.role === "system") {
      out.push({ role: "system", content: extractText(c) });
      continue;
    }
    if (m.role === "user") {
      const text = extractText(c);
      const images = extractUserImages(c);
      out.push({
        role: "user",
        content: text,
        ...(images.length > 0 ? { images } : {}),
      });
      continue;
    }
    if (m.role === "assistant") {
      const obj = (c ?? {}) as { text?: unknown; toolCalls?: unknown };
      const tc = Array.isArray(obj.toolCalls)
        ? (obj.toolCalls as Array<{ id: string; name: string; arguments: string }>)
        : undefined;
      // Layer-3 history-rebuild sanitization. Strip any tool-call shapes
      // that leaked into content text on a prior turn and replace with a
      // corrective marker — breaks the feedback loop where claude sees its
      // own bad output and learns to repeat the pattern.
      const rawText = extractText(c);
      const { cleaned, leaks } = sanitizeAssistantTextForRebuild(rawText, validToolNames);
      if (leaks.length > 0) {
        sanitizerLogger.info(
          `stripped ${leaks.length} leak(s) from assistant history: ` +
          leaks.map(l => `${l.shape}${l.toolName ? `(${l.toolName})` : ""}`).join(", "),
        );
      }
      out.push({
        role: "assistant",
        content: cleaned,
        ...(tc && tc.length > 0 ? { toolCalls: tc } : {}),
      });
      continue;
    }
    if (m.role === "tool_result") {
      const obj = (c ?? {}) as { toolCallId?: string; result?: unknown };
      const r = obj.result;
      // Vision-emitting tools (browser screenshot, image_read, etc.)
      // produce a `{ text, images: [{mime, b64}, ...] }` envelope so the
      // image bytes survive across the canonical seam. Detect the shape
      // and emit two transport messages: a `tool` row with the text
      // summary, then a follow-up `user` row carrying the images
      // sidecar so the next turn's adapter feeds them back to the model.
      let resultText: string;
      let imagesPayload: Array<{ mime: string; b64: string }> | null = null;
      if (r && typeof r === "object" && Array.isArray((r as { images?: unknown }).images)) {
        const env = r as { text?: unknown; images: unknown[] };
        resultText = typeof env.text === "string" ? env.text : JSON.stringify(env);
        imagesPayload = env.images.filter((x): x is { mime: string; b64: string } =>
          !!x && typeof x === "object" && typeof (x as { mime?: unknown }).mime === "string" && typeof (x as { b64?: unknown }).b64 === "string",
        );
      } else {
        resultText = typeof r === "string" ? r : JSON.stringify(r ?? null);
      }
      out.push({
        role: "tool",
        toolCallId: obj.toolCallId ?? "tc-unknown",
        content: resultText,
      });
      if (imagesPayload && imagesPayload.length > 0) {
        out.push({
          role: "user",
          content: `[Tool returned ${imagesPayload.length} image${imagesPayload.length === 1 ? "" : "s"} — analyze and use them in your reply.]`,
          images: imagesPayload.map((img, i) => ({
            url: `data:${img.mime};base64,${img.b64}`,
            name: `tool-image-${i}.${(img.mime.split("/")[1] || "png").replace(/[^a-z0-9]/gi, "")}`,
          })),
        });
      }
      continue;
    }
    if (m.role === "control") {
      const text = extractText(c);
      if (text) out.push({ role: "user", content: `[CONTROL] ${text}` });
      continue;
    }
  }
  if (pendingRedirect) {
    out.push({ role: "user", content: `[REDIRECT] ${pendingRedirect.text}` });
  }
  return out;
}

function extractText(c: unknown): string {
  if (c == null) return "";
  if (typeof c === "string") return c;
  if (typeof c === "object" && "text" in (c as Record<string, unknown>)) {
    const v = (c as { text?: unknown }).text;
    return typeof v === "string" ? v : "";
  }
  return "";
}

function extractUserImages(c: unknown): Array<{ url: string; name: string; filePath?: string }> {
  if (c == null || typeof c !== "object") return [];
  const v = (c as { images?: unknown }).images;
  if (!Array.isArray(v)) return [];
  const out: Array<{ url: string; name: string; filePath?: string }> = [];
  for (const x of v) {
    if (x && typeof x === "object" && typeof (x as { name?: unknown }).name === "string" && typeof (x as { url?: unknown }).url === "string") {
      const o = x as { url: string; name: string; filePath?: unknown };
      out.push({
        url: o.url,
        name: o.name,
        ...(typeof o.filePath === "string" ? { filePath: o.filePath } : {}),
      });
    }
  }
  return out;
}
