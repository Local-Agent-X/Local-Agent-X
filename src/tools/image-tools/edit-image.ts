import { writeFileSync, readFileSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import type { ToolDefinition, ToolResult } from "../../types.js";
import {
  ok, err, okWithImage, resolveMediaProvider, resolveLocalImagePath,
  findRecentLocalImage, workspaceDir, PROMPT_REFS_EARLIER_IMAGE,
} from "./shared.js";

interface LoadedImage { buf: Buffer; mime: string; filename: string; source: string; }

const EXT_FOR_MIME: Record<string, string> = { "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp" };

function mimeFromExt(path: string): string {
  const ext = (path.split(".").pop() || "").toLowerCase();
  return ext === "jpg" || ext === "jpeg" ? "image/jpeg" : ext === "webp" ? "image/webp" : "image/png";
}

/** Resolve an image reference (data URL, local path/URL, or remote http URL)
 *  into bytes + mime. Returns null if it can't be loaded. */
async function loadImage(ref: string): Promise<LoadedImage | null> {
  const s = (ref || "").trim();
  if (!s) return null;

  const data = s.match(/^data:(image\/[a-z+]+);base64,(.+)$/i);
  if (data) {
    const mime = data[1].toLowerCase();
    return { buf: Buffer.from(data[2], "base64"), mime, filename: `image.${EXT_FOR_MIME[mime] || "png"}`, source: "inline data URL" };
  }

  const local = resolveLocalImagePath(s);
  if (local) {
    const mime = mimeFromExt(local);
    return { buf: readFileSync(local), mime, filename: `image.${EXT_FOR_MIME[mime] || "png"}`, source: local };
  }

  if (/^https?:\/\//i.test(s)) {
    const res = await fetch(s, { signal: AbortSignal.timeout(30_000) });
    if (!res.ok) return null;
    const ct = (res.headers.get("content-type") || "").split(";")[0].trim().toLowerCase();
    const mime = ct.startsWith("image/") ? ct : mimeFromExt(s);
    return { buf: Buffer.from(await res.arrayBuffer()), mime, filename: `image.${EXT_FOR_MIME[mime] || "png"}`, source: s };
  }

  return null;
}

/** Persist edited bytes into the canonical workspace images/ dir and return a
 *  result that rides the bytes so chat + the messaging bridges forward it. */
function saveEdited(buffer: Buffer, lines: string[], prompt: string): ToolResult {
  const imagesDir = workspaceDir("images");
  if (!existsSync(imagesDir)) mkdirSync(imagesDir, { recursive: true });
  const filename = `edit_${Date.now()}.png`;
  const savePath = join(imagesDir, filename);
  writeFileSync(savePath, buffer);
  return okWithImage(
    [...lines, `Saved: ${savePath}`, `View: /images/${filename}`].join("\n"),
    { b64: buffer.toString("base64"), path: savePath, question: `Edited image: ${prompt}` },
  );
}

/** Edit via OpenAI gpt-image-1 — multipart upload of image (+ optional mask).
 *  A mask's transparent pixels mark the region to regenerate; everything else
 *  is preserved. With no mask the whole image is re-rendered from the prompt. */
async function editViaOpenai(
  prompt: string,
  apiKey: string,
  image: LoadedImage,
  mask: LoadedImage | null,
  size: string,
): Promise<ToolResult> {
  const form = new FormData();
  form.append("model", "gpt-image-1");
  form.append("prompt", prompt);
  form.append("image", new Blob([image.buf], { type: image.mime }), image.filename);
  if (mask) form.append("mask", new Blob([mask.buf], { type: "image/png" }), "mask.png");
  if (size && size !== "auto") form.append("size", size);

  const res = await fetch("https://api.openai.com/v1/images/edits", {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}` }, // FormData sets the multipart Content-Type + boundary
    body: form,
    signal: AbortSignal.timeout(180_000),
  });
  if (!res.ok) {
    const errText = await res.text();
    return err(`OpenAI image edit failed (${res.status}): ${errText.slice(0, 300)}`);
  }

  const body = (await res.json()) as { data?: Array<{ b64_json?: string; url?: string }> };
  const first = body.data?.[0];
  let buffer: Buffer;
  if (first?.b64_json) {
    buffer = Buffer.from(first.b64_json, "base64");
  } else if (first?.url) {
    const imgRes = await fetch(first.url, { signal: AbortSignal.timeout(30_000) });
    if (!imgRes.ok) return err("OpenAI returned an image URL that could not be fetched.");
    buffer = Buffer.from(await imgRes.arrayBuffer());
  } else {
    return err("OpenAI returned no edited image.");
  }

  return saveEdited(buffer, [
    `Image edited via OpenAI gpt-image-1!`,
    `Prompt: ${prompt}`,
    `Source: ${image.source}`,
    mask ? `Mask: ${mask.source} (only the masked region was regenerated)` : `No mask — whole image re-rendered from the prompt.`,
  ], prompt);
}

/** Edit via xAI Grok Imagine — POST /v1/images/edits with the source image as
 *  a base64 data URI (xAI can't reach 127.0.0.1 loopback URLs). Prompt-driven;
 *  xAI editing has no mask support, so the change is described in the prompt. */
async function editViaXai(
  prompt: string,
  apiKey: string,
  image: LoadedImage,
  quality: boolean,
): Promise<ToolResult> {
  const res = await fetch("https://api.x.ai/v1/images/edits", {
    method: "POST",
    headers: { "Content-Type": "application/json", "Authorization": `Bearer ${apiKey}` },
    body: JSON.stringify({
      model: quality ? "grok-imagine-image-quality" : "grok-imagine-image",
      prompt,
      image: { url: `data:${image.mime};base64,${image.buf.toString("base64")}`, type: "image_url" },
    }),
    signal: AbortSignal.timeout(120_000),
  });
  if (!res.ok) {
    const errText = await res.text();
    return err(`xAI image edit failed (${res.status}): ${errText.slice(0, 300)}`);
  }

  const body = (await res.json()) as { data?: Array<{ url?: string; b64_json?: string }> };
  const first = body.data?.[0];
  if (!first?.url && !first?.b64_json) return err("xAI returned no edited image.");
  let buffer: Buffer;
  if (first.b64_json) {
    buffer = Buffer.from(first.b64_json, "base64");
  } else {
    const imgRes = await fetch(first.url!, { signal: AbortSignal.timeout(30_000) });
    if (!imgRes.ok) return ok(`Image edited via Grok Imagine!\nPrompt: ${prompt}\nView: ${first.url}\n(Could not save locally)`);
    buffer = Buffer.from(await imgRes.arrayBuffer());
  }

  return saveEdited(buffer, [
    `Image edited via Grok Imagine (${quality ? "quality" : "fast"})!`,
    `Prompt: ${prompt}`,
    `Source: ${image.source}`,
    `Prompt-driven edit (xAI has no mask support — describe precise changes in the prompt).`,
  ], prompt);
}

export const editImageTool: ToolDefinition = {
  name: "edit_image",
  description:
    "Edit an EXISTING image instead of generating a new one — recolor, change, add, or remove part of a " +
    "photo while keeping the rest. ALWAYS use this (not generate_image) when the user gives you a photo to " +
    "modify. Defaults to xAI Grok Imagine when connected (prompt-driven edit, no mask); routes to OpenAI " +
    "gpt-image-1 when a `mask` is supplied or OpenAI is forced — only OpenAI does pixel-locked masked edits " +
    "(transparent mask pixels = regenerate, opaque = preserve exactly). For a precise 'change ONLY X' edit, " +
    "supplying a mask + OpenAI gives the cleanest result.",
  parameters: {
    type: "object",
    properties: {
      prompt: {
        type: "string",
        description: "Describe the change. Be specific about what to keep unchanged (e.g. 'change only the dial to deep green; keep the case, bezel, hands, bracelet, angle, lighting and background identical').",
      },
      image: {
        type: "string",
        description: "The source image to edit: an /images/… or /uploads/… URL, a local file path, an http(s) URL, or a data: URL. Omit only if the user just attached/generated one and the prompt refers to it.",
      },
      mask: {
        type: "string",
        description: "Optional PNG mask (OpenAI only). TRANSPARENT pixels mark the region to regenerate; opaque pixels are preserved exactly. Supplying a mask forces the OpenAI backend.",
      },
      size: {
        type: "string",
        description: "OpenAI output size: 'auto' (default, matches input), '1024x1024', '1536x1024', or '1024x1536'.",
      },
      quality: {
        type: "boolean",
        description: "xAI only. Use grok-imagine-image-quality (higher fidelity, better preservation; ~10-20s). Defaults true for edits since preserving the original matters.",
      },
      provider: {
        type: "string",
        description: "Optional. Force a backend: 'grok' (xAI), 'openai' (gpt-image-1, supports masks), or 'local' (unsupported for editing). Omit to use the default.",
      },
    },
    required: ["prompt"],
  },
  async execute(args) {
    const prompt = String(args.prompt || "");
    if (!prompt.trim()) return err("Prompt is required — describe the change to make.");

    const imageRef = typeof args.image === "string" ? args.image.trim() : "";
    let image = imageRef ? await loadImage(imageRef) : null;
    // Fall back to the most recent local image when none was passed (or the one
    // passed couldn't load) and the prompt clearly refers to an earlier image.
    if (!image && (!imageRef || PROMPT_REFS_EARLIER_IMAGE.test(prompt))) {
      const recent = findRecentLocalImage();
      if (recent) image = await loadImage(recent);
    }
    if (!image) {
      return err(imageRef
        ? `Could not load the source image: ${imageRef}`
        : "No source image to edit. Attach a photo (or pass `image`) for edit_image to modify.");
    }

    const maskRef = typeof args.mask === "string" ? args.mask.trim() : "";
    const mask = maskRef ? await loadImage(maskRef) : null;
    if (maskRef && !mask) return err(`Could not load the mask image: ${maskRef}`);

    const size = typeof args.size === "string" && args.size.trim() ? args.size.trim() : "auto";
    const quality = args.quality === undefined ? true : Boolean(args.quality);

    const { provider, apiKey, forced } = await resolveMediaProvider(args.provider as string | undefined);

    // Mask = pixel-locked editing, which only OpenAI gpt-image-1 supports. Never
    // silently route a masked request to xAI (which would ignore the mask).
    if (mask) {
      if (forced && provider !== "openai") {
        return err(
          `Masked edits run on OpenAI gpt-image-1 only — ${provider === "xai" ? "xAI Grok" : "local SD"} editing ` +
          `has no mask support. Drop the mask to edit on ${provider}, or connect OpenAI.`,
        );
      }
      const openaiKey = provider === "openai" ? apiKey : (await resolveMediaProvider("openai")).apiKey;
      if (!openaiKey) {
        return err(
          "Masked editing needs OpenAI (gpt-image-1) — the only backend that regenerates just the masked " +
          "region. Connect OpenAI in Settings → Providers, or drop the mask to do a prompt-only edit on your current provider.",
        );
      }
      try { return await editViaOpenai(prompt, openaiKey, image, mask, size); }
      catch (e) { return err(`OpenAI image edit failed: ${(e as Error).message}`); }
    }

    // No mask — prompt-driven edit on the resolved backend.
    if (provider === "xai" && apiKey) {
      try { return await editViaXai(prompt, apiKey, image, quality); }
      catch (e) { return err(`xAI image edit failed: ${(e as Error).message}`); }
    }
    if (provider === "openai" && apiKey) {
      try { return await editViaOpenai(prompt, apiKey, image, null, size); }
      catch (e) { return err(`OpenAI image edit failed: ${(e as Error).message}`); }
    }
    return err(
      provider === "local"
        ? "Local Stable Diffusion has no image-edit endpoint — editing needs xAI Grok or OpenAI. Connect one in Settings → Providers."
        : `${provider === "xai" ? "xAI Grok" : "OpenAI"} isn't connected. Connect it in Settings → Providers to edit images.`,
    );
  },
};
