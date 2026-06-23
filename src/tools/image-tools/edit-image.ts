import { writeFileSync, readFileSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import type { ToolDefinition, ToolResult } from "../../types.js";
import {
  err, okWithImage, resolveMediaProvider, resolveLocalImagePath,
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

  const imagesDir = workspaceDir("images");
  if (!existsSync(imagesDir)) mkdirSync(imagesDir, { recursive: true });
  const filename = `edit_${Date.now()}.png`;
  const savePath = join(imagesDir, filename);
  writeFileSync(savePath, buffer);

  return okWithImage(
    `Image edited via OpenAI gpt-image-1!\n` +
    `Prompt: ${prompt}\n` +
    `Source: ${image.source}\n` +
    `${mask ? `Mask: ${mask.source} (only the masked region was regenerated)` : "No mask — whole image re-rendered from the prompt."}\n` +
    `Saved: ${savePath}\n` +
    `View: /images/${filename}`,
    { b64: buffer.toString("base64"), path: savePath, question: `Edited image: ${prompt}` },
  );
}

export const editImageTool: ToolDefinition = {
  name: "edit_image",
  description:
    "Edit an existing image: regenerate only a masked region while keeping every other pixel intact " +
    "(e.g. 'change only the watch face color'). Pass `image` (the photo to edit) and, for a precise " +
    "change, a `mask` PNG whose transparent pixels mark the area to regenerate. Without a mask the whole " +
    "image is re-rendered from the prompt. Runs on OpenAI gpt-image-1 (the masked-edit backend); connect " +
    "OpenAI in Settings → Providers. For making a brand-new image from text, use generate_image instead.",
  parameters: {
    type: "object",
    properties: {
      prompt: {
        type: "string",
        description: "What to change. With a mask, describe what the masked region should become (e.g. 'a brushed gold watch face').",
      },
      image: {
        type: "string",
        description: "The source image to edit: an /images/… or /uploads/… URL, a local file path, an http(s) URL, or a data: URL. Omit only if the user just attached/generated one and the prompt refers to it.",
      },
      mask: {
        type: "string",
        description: "Optional PNG mask (same shape as `image`). TRANSPARENT pixels mark the region to regenerate; opaque pixels are preserved exactly. Omit to re-render the whole image.",
      },
      size: {
        type: "string",
        description: "Output size: 'auto' (default, matches input proportions), '1024x1024', '1536x1024', or '1024x1536'.",
      },
      provider: {
        type: "string",
        description: "Optional. Only 'openai' is supported for editing. Omit to use OpenAI automatically.",
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

    // gpt-image-1 is the only backend that does true masked / precise editing,
    // so edit_image always routes to OpenAI. We never silently retry on another
    // provider — if OpenAI isn't connected we surface that.
    const { provider, apiKey, forced } = await resolveMediaProvider(args.provider as string | undefined);
    if (forced && provider !== "openai") {
      return err(
        `edit_image runs on OpenAI gpt-image-1 (the masked-edit backend); ` +
        `${provider === "xai" ? "xAI Grok Imagine" : "local SD"} has no image-edit endpoint. ` +
        `Connect OpenAI in Settings → Providers, or omit the provider override.`,
      );
    }
    const openaiKey = provider === "openai" ? apiKey : (await resolveMediaProvider("openai")).apiKey;
    if (!openaiKey) {
      return err(
        "Image editing needs OpenAI (gpt-image-1) — the backend that regenerates only the masked " +
        "region while preserving the rest. Connect OpenAI in Settings → Providers.",
      );
    }

    try {
      return await editViaOpenai(prompt, openaiKey, image, mask, size);
    } catch (e) {
      return err(`OpenAI image edit failed: ${(e as Error).message}`);
    }
  },
};
