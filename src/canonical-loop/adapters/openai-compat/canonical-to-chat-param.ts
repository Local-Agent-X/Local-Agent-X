// Canonical messages → OpenAI ChatCompletionMessageParam[]. Distinct from
// canonicalToTransport because that helper produces TransportMessage[] with
// Anthropic-shaped `toolCalls`/`toolCallId` keys, while the OpenAI client
// expects `tool_calls`/`tool_call_id`. Handles vision attachments by
// expanding user messages into multi-part content (text + image_url) and
// emitting a follow-up user message when a tool result carries images.

import { readFileSync } from "node:fs";
import type { ChatCompletionMessageParam } from "openai/resources/chat/completions.js";
import type { CanonicalMessage } from "../../contract-types.js";
import type { TurnInput } from "../../adapter-contract.js";
import { sanitizeAssistantTextForRebuild } from "../../../anthropic-client/parse.js";
import { createLogger } from "../../../logger.js";
import { extractText } from "./helpers.js";
import type { CanonicalImageRef } from "./types.js";

const logger = createLogger("canonical-loop.adapters.openai-compat.chat-param");

export function canonicalToChatParam(
  messages: CanonicalMessage[],
  pendingRedirect: TurnInput["pendingRedirect"],
  validToolNames?: ReadonlySet<string>,
): ChatCompletionMessageParam[] {
  const out: ChatCompletionMessageParam[] = [];
  for (const m of messages) {
    const c = m.content as Record<string, unknown> | string | null | undefined;
    if (m.role === "system") {
      out.push({ role: "system", content: extractText(c) });
      continue;
    }
    if (m.role === "user") {
      const text = extractText(c);
      const images = extractImages(c);
      if (images.length > 0) {
        // Build OpenAI vision content parts: text + base64 image_url(s).
        // Mirrors the legacy buildUserContentWithImages format so existing
        // vision-capable models (gpt-5, qwen-vl, gemini, etc.) parse the
        // request unchanged. File reads happen synchronously here — small
        // cost paid once per turn, no async on the hot path.
        out.push({ role: "user", content: imagesToOpenAIParts(text, images) });
      } else {
        out.push({ role: "user", content: text });
      }
      continue;
    }
    if (m.role === "assistant") {
      const obj = (c ?? {}) as { text?: unknown; toolCalls?: unknown };
      const tc = Array.isArray(obj.toolCalls)
        ? (obj.toolCalls as Array<{ id: string; name: string; arguments: string }>)
        : undefined;
      // Layer-3 history-rebuild sanitization — see parse.ts. Strips
      // tool-call-shaped JSON / XML / tree-style notation from prior
      // assistant text so the model doesn't mimic its own bad output.
      const rawText = extractText(c);
      const { cleaned: text, leaks } = sanitizeAssistantTextForRebuild(rawText, validToolNames);
      if (leaks.length > 0) {
        logger.info(
          `stripped ${leaks.length} leak(s) from assistant history: ` +
          leaks.map(l => `${l.shape}${l.toolName ? `(${l.toolName})` : ""}`).join(", "),
        );
      }
      if (tc && tc.length > 0) {
        out.push({
          role: "assistant",
          content: text,
          tool_calls: tc.map(t => ({
            id: t.id,
            type: "function",
            function: { name: t.name, arguments: t.arguments },
          })),
        });
      } else {
        out.push({ role: "assistant", content: text });
      }
      continue;
    }
    if (m.role === "tool_result") {
      const obj = (c ?? {}) as { toolCallId?: string; result?: unknown };
      const r = obj.result;
      // Vision-emitting tools (browser screenshot, image_read, etc.)
      // produce a `{ text, images: [{mime, b64}, ...] }` envelope. Emit
      // a tool message with the text summary, then a follow-up user
      // message with image_url multi-part content so the next turn's
      // model actually sees the image. Mirrors the legacy
      // tool-executor.ts pattern at line ~677.
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
        tool_call_id: obj.toolCallId ?? "tc-unknown",
        content: resultText,
      });
      if (imagesPayload && imagesPayload.length > 0) {
        const parts: Array<{ type: "text"; text: string } | { type: "image_url"; image_url: { url: string; detail?: "auto" | "low" | "high" } }> = [
          { type: "text", text: `[Tool returned ${imagesPayload.length} image${imagesPayload.length === 1 ? "" : "s"} — analyze and use them in your reply.]` },
        ];
        for (const img of imagesPayload) {
          parts.push({ type: "image_url", image_url: { url: `data:${img.mime};base64,${img.b64}`, detail: "auto" } });
        }
        out.push({ role: "user", content: parts });
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

function extractImages(c: unknown): CanonicalImageRef[] {
  if (c == null || typeof c !== "object") return [];
  const v = (c as { images?: unknown }).images;
  if (!Array.isArray(v)) return [];
  return v.filter((x): x is CanonicalImageRef =>
    !!x && typeof x === "object" && typeof (x as CanonicalImageRef).name === "string",
  );
}

/**
 * Build OpenAI vision content parts: a text part plus one image_url
 * part per attachment, base64-data-url'd from the on-disk file. Mirrors
 * `buildUserContentWithImages` in run-standard-helpers.ts (legacy path)
 * so the wire shape is identical for any provider that's vision-capable.
 *
 * Adds a trailing text part listing on-disk file paths so the agent can
 * `read`/`bash cp` the original bytes when an app needs the asset on
 * disk (matches legacy behavior — the agent uses these hints to avoid
 * regenerating an image when the user already attached one).
 */
function imagesToOpenAIParts(
  text: string,
  images: CanonicalImageRef[],
): Array<{ type: "text"; text: string } | { type: "image_url"; image_url: { url: string; detail?: "auto" | "low" | "high" } }> {
  const parts: Array<{ type: "text"; text: string } | { type: "image_url"; image_url: { url: string; detail?: "auto" | "low" | "high" } }> = [
    { type: "text", text },
  ];
  const filePathHints: string[] = [];
  for (const img of images) {
    try {
      if (!img.filePath) continue;
      const data = readFileSync(img.filePath);
      const ext = (img.name.split(".").pop() || "png").toLowerCase();
      const mime = ext === "jpg" ? "image/jpeg" : `image/${ext}`;
      const dataUrl = `data:${mime};base64,${data.toString("base64")}`;
      parts.push({ type: "image_url", image_url: { url: dataUrl, detail: "auto" } });
      filePathHints.push(`  - ${img.name} → ${img.filePath}`);
    } catch {
      // Skip unreadable attachments rather than fail the whole turn.
    }
  }
  if (filePathHints.length > 0) {
    parts.push({
      type: "text",
      text:
        `\n\n[Attached file paths on disk — use these if you need to copy the real bytes into the workspace]\n` +
        filePathHints.join("\n") +
        `\n\nTo use an attachment as an app asset: read the file with bash/read, then write it to the target path under workspace/apps/<app>/, or use bash cp. Do NOT generate a new image or download from the web when a user attachment exists — use the file at the path above.`,
    });
  }
  return parts;
}
