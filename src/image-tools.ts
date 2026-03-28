import { writeFileSync, readFileSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import type { ToolDefinition, ToolResult } from "./types.js";
import type { SecretsStore } from "./secrets.js";

function ok(content: string): ToolResult {
  return { content };
}
function err(content: string): ToolResult {
  return { content, isError: true };
}

const SD_SERVER_URL = "http://127.0.0.1:7860";

/**
 * Image generation via local Stable Diffusion server.
 * The SD server runs on port 7860 and must be started separately:
 *   python workspace/sd-server/server.py
 *
 * Falls back to a helpful error if the server isn't running.
 */
// Injected at runtime via createImageTools()
let _secretsStore: SecretsStore | undefined;

/** Get current provider + API key from settings + secrets */
function getActiveProvider(): { provider: string; apiKey?: string } {
  const settingsPath = join(homedir(), ".sax", "settings.json");
  let provider = "local";
  try {
    if (existsSync(settingsPath)) {
      const s = JSON.parse(readFileSync(settingsPath, "utf-8"));
      provider = s.provider || "local";
    }
  } catch {}

  let apiKey: string | undefined;
  if (_secretsStore) {
    const keyName = provider === "xai" ? "XAI_API_KEY" : provider === "openai" ? "OPENAI_API_KEY" : "";
    if (keyName) apiKey = _secretsStore.get(keyName);
  }

  return { provider, apiKey };
}

/** Generate image via xAI Grok API */
async function generateViaXai(prompt: string, apiKey: string): Promise<ToolResult> {
  const res = await fetch("https://api.x.ai/v1/images/generations", {
    method: "POST",
    headers: { "Content-Type": "application/json", "Authorization": `Bearer ${apiKey}` },
    body: JSON.stringify({ model: "grok-2-image", prompt, n: 1, response_format: "url" }),
    signal: AbortSignal.timeout(60_000),
  });
  if (!res.ok) {
    const errText = await res.text();
    return err(`xAI image generation failed (${res.status}): ${errText.slice(0, 300)}`);
  }
  const data = (await res.json()) as { data: Array<{ url: string; revised_prompt?: string }> };
  if (!data.data?.[0]?.url) return err("xAI returned no image.");

  const imageUrl = data.data[0].url;

  // Download and save locally
  const imgRes = await fetch(imageUrl, { signal: AbortSignal.timeout(30_000) });
  if (!imgRes.ok) return ok(`Image generated!\nPrompt: ${prompt}\nView: ${imageUrl}\n(Could not save locally)`);

  const buffer = Buffer.from(await imgRes.arrayBuffer());
  const imagesDir = join("workspace", "generated");
  if (!existsSync(imagesDir)) mkdirSync(imagesDir, { recursive: true });
  const filename = `grok_${Date.now()}.png`;
  const savePath = join(imagesDir, filename);
  writeFileSync(savePath, buffer);

  return ok(
    `Image generated via Grok!\n` +
    `Prompt: ${prompt}\n` +
    `Saved: ${savePath}\n` +
    `View: /uploads/../workspace/generated/${filename}`
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
    },
    required: ["prompt"],
  },
  async execute(args) {
    const prompt = String(args.prompt || "");
    if (!prompt.trim()) return err("Prompt is required.");

    // Check active provider — use API image gen if available
    const { provider, apiKey } = getActiveProvider();

    if (provider === "xai" && apiKey) {
      try { return await generateViaXai(prompt, apiKey); }
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
      const healthRes = await fetch(`${SD_SERVER_URL}/health`, {
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
      const res = await fetch(`${SD_SERVER_URL}/generate`, {
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

      const localUrl = `http://127.0.0.1:4800/images/${data.filename}`;

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

const VIDEO_SERVER_URL = "http://127.0.0.1:7861";

const generateVideoTool: ToolDefinition = {
  name: "generate_video",
  description:
    "Generate a short video (~6 seconds) from a text prompt using local CogVideoX (runs on your GPU). " +
    "The video server must be running on port 7861. If not running, use bash to start it: " +
    "'python workspace/sd-server/video-server.py' (first run downloads ~4GB model). " +
    "Use detailed prompts for best results. Videos are saved as MP4.",
  parameters: {
    type: "object",
    properties: {
      prompt: {
        type: "string",
        description: "Detailed text description of the video to generate",
      },
      num_frames: {
        type: "number",
        description: "Number of frames (default 49 = ~6 seconds at 8fps, max 81)",
      },
      steps: {
        type: "number",
        description: "Inference steps (default 50, more = higher quality but slower)",
      },
    },
    required: ["prompt"],
  },
  async execute(args) {
    const prompt = String(args.prompt || "");
    if (!prompt.trim()) return err("Prompt is required.");

    const numFrames = Math.min(81, Math.max(17, Number(args.num_frames) || 49));
    const steps = Math.min(80, Math.max(20, Number(args.steps) || 50));

    // Check if video server is running
    try {
      const healthRes = await fetch(`${VIDEO_SERVER_URL}/health`, {
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
      const res = await fetch(`${VIDEO_SERVER_URL}/generate`, {
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

      const localUrl = `http://127.0.0.1:4800/videos/${data.filename}`;

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
