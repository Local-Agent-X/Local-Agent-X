import { writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import type { ToolDefinition, ToolResult } from "../types.js";
import { getRuntimeConfig } from "../config.js";
import { ok, err, getActiveProvider } from "./shared.js";

/** Stable Diffusion server URL — configurable via config.sdServerUrl */
function getSDServerUrl(): string { return getRuntimeConfig().sdServerUrl; }

/** Map LAX-style aspect (square/landscape/portrait) → xAI aspect ratio string. */
function xaiAspectRatio(aspect?: string): string {
  switch ((aspect || "").toLowerCase()) {
    case "landscape": case "16:9": return "16:9";
    case "portrait":  case "9:16": return "9:16";
    case "4:3": case "3:4": case "3:2": case "2:3": return aspect as string;
    default: return "1:1";
  }
}

/** Generate image via xAI Grok Imagine. */
async function generateViaXai(
  prompt: string,
  apiKey: string,
  aspect?: string,
  quality?: boolean,
): Promise<ToolResult> {
  const res = await fetch("https://api.x.ai/v1/images/generations", {
    method: "POST",
    headers: { "Content-Type": "application/json", "Authorization": `Bearer ${apiKey}` },
    body: JSON.stringify({
      model: quality ? "grok-imagine-image-quality" : "grok-imagine-image",
      prompt,
      aspect_ratio: xaiAspectRatio(aspect),
      resolution: "1k",
    }),
    signal: AbortSignal.timeout(60_000),
  });
  if (!res.ok) {
    const errText = await res.text();
    return err(`xAI image generation failed (${res.status}): ${errText.slice(0, 300)}`);
  }
  const data = (await res.json()) as { data: Array<{ url?: string; b64_json?: string }> };
  const first = data.data?.[0];
  if (!first?.url && !first?.b64_json) return err("xAI returned no image.");

  // Write into workspace/images/ so the /images/<file> static mount serves it.
  const imagesDir = join("workspace", "images");
  if (!existsSync(imagesDir)) mkdirSync(imagesDir, { recursive: true });
  const filename = `grok_${Date.now()}.png`;
  const savePath = join(imagesDir, filename);

  let buffer: Buffer;
  if (first.b64_json) {
    buffer = Buffer.from(first.b64_json, "base64");
  } else {
    const imgRes = await fetch(first.url!, { signal: AbortSignal.timeout(30_000) });
    if (!imgRes.ok) return ok(`Image generated!\nPrompt: ${prompt}\nView: ${first.url}\n(Could not save locally)`);
    buffer = Buffer.from(await imgRes.arrayBuffer());
  }
  writeFileSync(savePath, buffer);

  return ok(
    `Image generated via Grok Imagine!\n` +
    `Prompt: ${prompt}\n` +
    `Saved: ${savePath}\n` +
    `View: /images/${filename}`
  );
}

/** Generate image via OpenAI DALL-E API */
async function generateViaOpenai(prompt: string, apiKey: string): Promise<ToolResult> {
  const res = await fetch("https://api.openai.com/v1/images/generations", {
    method: "POST",
    headers: { "Content-Type": "application/json", "Authorization": `Bearer ${apiKey}` },
    body: JSON.stringify({ model: "dall-e-3", prompt, n: 1, size: "1024x1024", response_format: "url" }),
    signal: AbortSignal.timeout(60_000),
  });
  if (!res.ok) {
    const errText = await res.text();
    return err(`OpenAI image generation failed (${res.status}): ${errText.slice(0, 300)}`);
  }
  const data = (await res.json()) as { data: Array<{ url: string; revised_prompt?: string }> };
  if (!data.data?.[0]?.url) return err("OpenAI returned no image.");

  const imageUrl = data.data[0].url;
  const imgRes = await fetch(imageUrl, { signal: AbortSignal.timeout(30_000) });
  if (!imgRes.ok) return ok(`Image generated!\nPrompt: ${prompt}\nView: ${imageUrl}\n(Could not save locally)`);

  const buffer = Buffer.from(await imgRes.arrayBuffer());
  const imagesDir = join("workspace", "generated");
  if (!existsSync(imagesDir)) mkdirSync(imagesDir, { recursive: true });
  const filename = `dalle_${Date.now()}.png`;
  const savePath = join(imagesDir, filename);
  writeFileSync(savePath, buffer);

  return ok(
    `Image generated via DALL-E!\n` +
    `Prompt: ${prompt}\n` +
    `Saved: ${savePath}\n` +
    `View: /uploads/../workspace/generated/${filename}`
  );
}

export const generateImageTool: ToolDefinition = {
  name: "generate_image",
  description:
    "Generate an image from a text prompt. " +
    "Automatically uses the best available backend: xAI Grok image API, OpenAI DALL-E, or local Stable Diffusion. " +
    "Use detailed prompts for best results.",
  parameters: {
    type: "object",
    properties: {
      prompt: {
        type: "string",
        description: "Detailed text description of the image to generate",
      },
      width: {
        type: "number",
        description: "Image width in pixels (default 512, max 1024) — only used for local SD",
      },
      height: {
        type: "number",
        description: "Image height in pixels (default 512, max 1024) — only used for local SD",
      },
      steps: {
        type: "number",
        description: "Number of diffusion steps (default 25) — only used for local SD",
      },
      guidance: {
        type: "number",
        description: "Guidance scale (default 7.5) — only used for local SD",
      },
      aspect: {
        type: "string",
        description: "Aspect ratio for xAI Grok Imagine: square (1:1), landscape (16:9), portrait (9:16), 4:3, 3:4, 3:2, 2:3. Default square.",
      },
      quality: {
        type: "boolean",
        description: "Use grok-imagine-image-quality (higher fidelity, ~10-20s) instead of the default grok-imagine-image (~5-10s). Only applies to xAI backend.",
      },
    },
    required: ["prompt"],
  },
  async execute(args) {
    const prompt = String(args.prompt || "");
    if (!prompt.trim()) return err("Prompt is required.");

    const { provider, apiKey } = await getActiveProvider();

    if (provider === "xai" && apiKey) {
      try { return await generateViaXai(prompt, apiKey, args.aspect as string | undefined, Boolean(args.quality)); }
      catch (e) { return err(`xAI image generation failed: ${(e as Error).message}`); }
    }

    if (provider === "openai" && apiKey) {
      try { return await generateViaOpenai(prompt, apiKey); }
      catch (e) { return err(`OpenAI image generation failed: ${(e as Error).message}`); }
    }

    // Fall back to local Stable Diffusion
    const width = Math.min(1024, Math.max(256, Number(args.width) || 512));
    const height = Math.min(1024, Math.max(256, Number(args.height) || 512));
    const steps = Math.min(50, Math.max(10, Number(args.steps) || 25));
    const guidance = Number(args.guidance) || 7.5;

    try {
      const healthRes = await fetch(`${getSDServerUrl()}/health`, {
        signal: AbortSignal.timeout(2000),
      });
      if (!healthRes.ok) throw new Error("not ok");
    } catch {
      return err(
        "No API image generation available and Stable Diffusion server is not running.\n" +
        "Start it with bash: python workspace/sd-server/server.py\n" +
        "(First run downloads the model ~4GB, takes a few minutes)"
      );
    }

    try {
      const res = await fetch(`${getSDServerUrl()}/generate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prompt, width, height, steps, guidance }),
        signal: AbortSignal.timeout(120_000),
      });

      if (!res.ok) {
        const errBody = await res.text();
        return err(`Image generation failed: ${errBody.slice(0, 300)}`);
      }

      const data = (await res.json()) as {
        filename: string;
        path: string;
        size: number;
        width: number;
        height: number;
        prompt: string;
      };

      const localUrl = `http://127.0.0.1:${getRuntimeConfig().port}/images/${data.filename}`;

      return ok(
        `Image generated!\n` +
        `Prompt: ${prompt}\n` +
        `Size: ${data.width}x${data.height} | Steps: ${steps}\n` +
        `View: ${localUrl}\n` +
        `Saved: workspace/images/${data.filename}`
      );
    } catch (e) {
      const msg = (e as Error).message;
      if (msg.includes("timeout")) {
        return err("Image generation timed out (>2 min). Try fewer steps or smaller size.");
      }
      return err(`Image generation failed: ${msg}`);
    }
  },
};
