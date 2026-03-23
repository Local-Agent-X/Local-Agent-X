import { writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import type { ToolDefinition, ToolResult } from "./types.js";

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
const generateImageTool: ToolDefinition = {
  name: "generate_image",
  description:
    "Generate an image from a text prompt using local Stable Diffusion (runs on your GPU). " +
    "The SD server must be running on port 7860. If not running, use bash to start it: " +
    "'python workspace/sd-server/server.py' (first run downloads ~4GB model). " +
    "Use detailed prompts for best results. Supports custom size, steps, and guidance scale.",
  parameters: {
    type: "object",
    properties: {
      prompt: {
        type: "string",
        description: "Detailed text description of the image to generate",
      },
      width: {
        type: "number",
        description: "Image width in pixels (default 512, max 1024)",
      },
      height: {
        type: "number",
        description: "Image height in pixels (default 512, max 1024)",
      },
      steps: {
        type: "number",
        description: "Number of diffusion steps (default 25, more = higher quality but slower)",
      },
      guidance: {
        type: "number",
        description: "Guidance scale — how closely to follow the prompt (default 7.5, higher = more literal)",
      },
    },
    required: ["prompt"],
  },
  async execute(args) {
    const prompt = String(args.prompt || "");
    if (!prompt.trim()) return err("Prompt is required.");

    const width = Math.min(1024, Math.max(256, Number(args.width) || 512));
    const height = Math.min(1024, Math.max(256, Number(args.height) || 512));
    const steps = Math.min(50, Math.max(10, Number(args.steps) || 25));
    const guidance = Number(args.guidance) || 7.5;

    // Check if SD server is running
    try {
      const healthRes = await fetch(`${SD_SERVER_URL}/health`, {
        signal: AbortSignal.timeout(2000),
      });
      if (!healthRes.ok) throw new Error("not ok");
    } catch {
      return err(
        "Stable Diffusion server is not running.\n" +
        "Start it with bash: python workspace/sd-server/server.py\n" +
        "(First run downloads the model ~4GB, takes a few minutes)"
      );
    }

    try {
      const res = await fetch(`${SD_SERVER_URL}/generate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prompt, width, height, steps, guidance }),
        signal: AbortSignal.timeout(120_000), // 2 min timeout for generation
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

export const imageTools: ToolDefinition[] = [generateImageTool];
