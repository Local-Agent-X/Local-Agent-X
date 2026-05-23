import { writeFileSync, readFileSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { randomUUID } from "node:crypto";
import type { ToolDefinition, ToolResult } from "./types.js";
import type { SecretsStore } from "./secrets.js";
import { createLogger } from "./logger.js";

const xaiLogger = createLogger("image-tools.xai");

function ok(content: string): ToolResult {
  return { content };
}
function err(content: string): ToolResult {
  return { content, isError: true };
}

import { getRuntimeConfig } from "./config.js";

/** Stable Diffusion server URL — configurable via config.sdServerUrl */
function getSDServerUrl(): string { return getRuntimeConfig().sdServerUrl; }

/**
 * Image generation via local Stable Diffusion server.
 * The SD server runs on port 7860 and must be started separately:
 *   python workspace/sd-server/server.py
 *
 * Falls back to a helpful error if the server isn't running.
 */
// Injected at runtime via createImageTools()
let _secretsStore: SecretsStore | undefined;

/** Get current provider + API key from settings + secrets. For xai, prefer
 *  the SuperGrok / X Premium+ OAuth bearer over the API key — same wire
 *  shape, but the OAuth bearer draws from subscription quota instead of
 *  API spend. */
async function getActiveProvider(): Promise<{ provider: string; apiKey?: string }> {
  const settingsPath = join(homedir(), ".lax", "settings.json");
  let provider = "local";
  try {
    if (existsSync(settingsPath)) {
      const s = JSON.parse(readFileSync(settingsPath, "utf-8"));
      provider = s.provider || "local";
    }
  } catch {}

  let apiKey: string | undefined;
  if (provider === "xai") {
    try {
      const { getXaiApiKey } = await import("./auth-xai.js");
      const oauth = await getXaiApiKey();
      if (oauth) apiKey = oauth;
    } catch {}
    if (!apiKey && _secretsStore) apiKey = _secretsStore.get("XAI_API_KEY") || undefined;
  } else if (provider === "openai" && _secretsStore) {
    apiKey = _secretsStore.get("OPENAI_API_KEY") || undefined;
  }

  return { provider, apiKey };
}

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

const generateImageTool: ToolDefinition = {
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

    // Check active provider — use API image gen if available
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

/** Video generation server URL — configurable via config.videoServerUrl */
function getVideoServerUrl(): string { return getRuntimeConfig().videoServerUrl; }

/** Generate video via xAI Grok Imagine (text-to-video, async polling).
 *  POST /v1/videos/generations returns { request_id }, then we poll
 *  GET /v1/videos/{request_id} until status=done. Final body has the
 *  video URL, which we fetch and save as MP4. */
async function generateViaXaiVideo(
  prompt: string,
  apiKey: string,
  duration: number,
  referenceImageUrls?: string[],
): Promise<ToolResult> {
  const headers = { "Content-Type": "application/json", "Authorization": `Bearer ${apiKey}` };

  // Normalize reference image URLs. Grok's tool-call sometimes serializes
  // an array as a JSON-encoded string ("[\"foo.png\"]") instead of a real
  // array, so unwrap that first. Local LAX paths (/images/foo.png OR
  // workspace/images/foo.png) point at the loopback host — xAI's backend
  // can't reach 127.0.0.1, so we inline the file as base64 instead.
  const refs: Array<{ url: string }> = [];
  for (const raw of referenceImageUrls || []) {
    const u = (raw || "").trim();
    if (!u) continue;
    // /images/foo.png  OR  workspace/images/foo.png  OR  bare filename in /images
    const localMatch = u.match(/(?:^\/images\/|^workspace\/images\/)([A-Za-z0-9._-]+)/);
    if (localMatch) {
      const filePath = join("workspace", "images", localMatch[1]);
      if (existsSync(filePath)) {
        const ext = (localMatch[1].split(".").pop() || "png").toLowerCase();
        const mime = ext === "jpg" || ext === "jpeg" ? "image/jpeg" : ext === "webp" ? "image/webp" : "image/png";
        const b64 = readFileSync(filePath).toString("base64");
        refs.push({ url: `data:${mime};base64,${b64}` });
        continue;
      }
    }
    // External http(s) URL or unknown shape — pass through and let xAI decide.
    refs.push({ url: u });
  }
  // Reference-image path caps at 10s per xAI's docs.
  const clamped = Math.max(1, Math.min(refs.length > 0 ? 10 : 15, Math.floor(duration)));

  const body: Record<string, unknown> = {
    model: "grok-imagine-video",
    prompt,
    duration: clamped,
  };
  if (refs.length > 0) body.reference_images = refs;

  xaiLogger.info(`[xai-video] submitting prompt="${prompt.slice(0, 80)}" duration=${clamped} refs=${refs.length}`);
  const submit = await fetch("https://api.x.ai/v1/videos/generations", {
    method: "POST",
    headers: { ...headers, "x-idempotency-key": randomUUID() },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(60_000),
  });
  if (!submit.ok) {
    const errText = await submit.text();
    xaiLogger.error(`[xai-video] SUBMIT FAILED (${submit.status}): ${errText.slice(0, 500)}`);
    return err(`xAI video submit failed (${submit.status}): ${errText.slice(0, 300)}`);
  }
  const submitted = await submit.json() as { request_id?: string };
  const requestId = submitted.request_id;
  if (!requestId) return err("xAI video response missing request_id");

  // Poll for completion — Grok Imagine videos run ~60-240s.
  const deadline = Date.now() + 6 * 60 * 1000;
  let videoUrl: string | null = null;
  let lastStatus = "queued";
  while (Date.now() < deadline) {
    await new Promise(r => setTimeout(r, 5000));
    const poll = await fetch(`https://api.x.ai/v1/videos/${requestId}`, {
      headers, signal: AbortSignal.timeout(30_000),
    });
    if (!poll.ok) {
      const errText = await poll.text();
      return err(`xAI video poll failed (${poll.status}): ${errText.slice(0, 300)}`);
    }
    const pollBody = await poll.json() as {
      status?: string;
      video?: { url?: string };
      url?: string;
      error?: string | { message?: string };
      failure_reason?: string;
      message?: string;
    };
    lastStatus = (pollBody.status || "").toLowerCase();
    if (lastStatus === "done") { videoUrl = pollBody.video?.url || pollBody.url || null; break; }
    if (["failed", "error", "expired", "cancelled"].includes(lastStatus)) {
      const reason =
        (typeof pollBody.error === "string" ? pollBody.error : pollBody.error?.message) ||
        pollBody.failure_reason ||
        pollBody.message ||
        "no reason returned by xAI";
      xaiLogger.error(`[xai-video] STATUS=${lastStatus} reason=${reason} request=${requestId} full=${JSON.stringify(pollBody).slice(0, 800)}`);
      return err(`xAI video generation ${lastStatus} (${reason}). request=${requestId}`);
    }
  }
  if (!videoUrl) return err(`xAI video generation timed out (last status: ${lastStatus})`);

  const vidRes = await fetch(videoUrl, { signal: AbortSignal.timeout(60_000) });
  if (!vidRes.ok) return ok(`Video generated!\nPrompt: ${prompt}\nView: ${videoUrl}\n(Could not save locally)`);
  const buffer = Buffer.from(await vidRes.arrayBuffer());
  const videosDir = join("workspace", "videos");
  if (!existsSync(videosDir)) mkdirSync(videosDir, { recursive: true });
  const filename = `grok_${Date.now()}.mp4`;
  const savePath = join(videosDir, filename);
  writeFileSync(savePath, buffer);

  return ok(
    `Video generated via Grok Imagine!\n` +
    `Prompt: ${prompt}\n` +
    `Duration: ${clamped}s\n` +
    `Saved: ${savePath}\n` +
    `View: http://127.0.0.1:${getRuntimeConfig().port}/videos/${filename}`
  );
}

const generateVideoTool: ToolDefinition = {
  name: "generate_video",
  description:
    "Generate a short video from a text prompt. When provider=xai with credentials, uses xAI Grok Imagine " +
    "(text-to-video, ~60-240s, up to 15s duration, optional reference images). Otherwise falls back to local CogVideoX " +
    "(must be running on port 7861, ~6 second outputs). Videos saved as MP4.",
  parameters: {
    type: "object",
    properties: {
      prompt: {
        type: "string",
        description: "Detailed text description of the video to generate",
      },
      num_frames: {
        type: "number",
        description: "Number of frames (default 49 = ~6 seconds at 8fps, max 81) — local CogVideoX only",
      },
      steps: {
        type: "number",
        description: "Inference steps (default 50, more = higher quality but slower) — local CogVideoX only",
      },
      duration: {
        type: "number",
        description: "Seconds (1-15, capped at 10 if reference_images supplied). xAI Grok Imagine only. Default 8.",
      },
      reference_images: {
        type: "array",
        items: { type: "string" },
        description: "Up to 7 reference image URLs for style/character guidance. xAI Grok Imagine only.",
      },
    },
    required: ["prompt"],
  },
  async execute(args) {
    const prompt = String(args.prompt || "");
    if (!prompt.trim()) return err("Prompt is required.");

    // Try xAI Grok Imagine first when provider=xai and creds are configured.
    const { provider, apiKey } = await getActiveProvider();
    if (provider === "xai" && apiKey) {
      try {
        // Grok-4 sometimes sends reference_images as a JSON-encoded string
        // instead of a real array ("[\"foo.png\"]"). Parse both shapes so
        // either survives. Single string → treat as one ref. Anything
        // unparseable → no refs.
        let refs: string[] | undefined;
        const rawRefs = args.reference_images;
        if (Array.isArray(rawRefs)) {
          refs = rawRefs.map(String);
        } else if (typeof rawRefs === "string" && rawRefs.trim()) {
          const t = rawRefs.trim();
          if (t.startsWith("[")) {
            try {
              const parsed = JSON.parse(t);
              if (Array.isArray(parsed)) refs = parsed.map(String);
            } catch { /* fall through */ }
          }
          if (!refs) refs = [t];
        }
        const dur = Number(args.duration) || 8;
        return await generateViaXaiVideo(prompt, apiKey, dur, refs);
      } catch (e) {
        // Fall through to local CogVideoX on xAI failure — gives the user
        // a working fallback if SuperGrok hits the 403 allowlist gate.
        const msg = (e as Error).message;
        if (!/timeout|aborted/i.test(msg)) {
          return err(`xAI video generation failed: ${msg}`);
        }
      }
    }

    const numFrames = Math.min(81, Math.max(17, Number(args.num_frames) || 49));
    const steps = Math.min(80, Math.max(20, Number(args.steps) || 50));

    // Check if video server is running
    try {
      const healthRes = await fetch(`${getVideoServerUrl()}/health`, {
        signal: AbortSignal.timeout(2000),
      });
      if (!healthRes.ok) throw new Error("not ok");
    } catch {
      return err(
        "Video server is not running.\n" +
        "Start it with bash: python workspace/sd-server/video-server.py\n" +
        "(First run downloads CogVideoX model ~4GB, takes a few minutes)"
      );
    }

    try {
      const res = await fetch(`${getVideoServerUrl()}/generate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prompt, num_frames: numFrames, steps }),
        signal: AbortSignal.timeout(300_000), // 5 min timeout — video gen is slow
      });

      if (!res.ok) {
        const errBody = await res.text();
        return err(`Video generation failed: ${errBody.slice(0, 300)}`);
      }

      const data = (await res.json()) as {
        filename: string;
        path: string;
        size: number;
        frames: number;
        prompt: string;
      };

      const localUrl = `http://127.0.0.1:${getRuntimeConfig().port}/videos/${data.filename}`;

      return ok(
        `Video generated!\n` +
        `Prompt: ${prompt}\n` +
        `Frames: ${data.frames} (~${Math.round(data.frames / 8)}s at 8fps)\n` +
        `Size: ${Math.round(data.size / 1024)}KB\n` +
        `View: ${localUrl}\n` +
        `Saved: workspace/videos/${data.filename}`
      );
    } catch (e) {
      const msg = (e as Error).message;
      if (msg.includes("timeout")) {
        return err("Video generation timed out (>5 min). Try fewer frames or steps.");
      }
      return err(`Video generation failed: ${msg}`);
    }
  },
};

export const imageTools: ToolDefinition[] = [generateImageTool, generateVideoTool];

/** Call this at startup to inject the secrets store for API-based image generation */
export function initImageTools(secrets: SecretsStore) {
  _secretsStore = secrets;
}
