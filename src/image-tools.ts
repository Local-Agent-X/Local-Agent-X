import { writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import type { ToolDefinition, ToolResult } from "./types.js";
import { getApiKey, loadTokens } from "./auth.js";

function ok(content: string): ToolResult {
  return { content };
}
function err(content: string): ToolResult {
  return { content, isError: true };
}

/**
 * Image generation via OpenAI DALL-E API.
 * Uses the same OAuth token as the chat (Codex/ChatGPT subscription).
 */
const generateImageTool: ToolDefinition = {
  name: "generate_image",
  description:
    "Generate an image from a text prompt using DALL-E. Returns a viewable URL and saves it locally. " +
    "Use detailed, descriptive prompts for best results. " +
    "Examples: 'a cyberpunk city at night, neon lights reflecting on wet streets', " +
    "'a golden retriever wearing sunglasses sitting on a beach at sunset, photorealistic'.",
  parameters: {
    type: "object",
    properties: {
      prompt: {
        type: "string",
        description: "Detailed text description of the image to generate",
      },
      size: {
        type: "string",
        enum: ["1024x1024", "1024x1792", "1792x1024"],
        description: "Image size (default: 1024x1024). 1024x1792 for portrait, 1792x1024 for landscape.",
      },
      quality: {
        type: "string",
        enum: ["standard", "hd"],
        description: "Image quality — 'hd' for more detail (default: standard)",
      },
      style: {
        type: "string",
        enum: ["vivid", "natural"],
        description: "vivid = hyper-real/dramatic, natural = more realistic (default: vivid)",
      },
    },
    required: ["prompt"],
  },
  async execute(args) {
    const prompt = String(args.prompt || "");
    if (!prompt.trim()) return err("Prompt is required.");

    const size = String(args.size || "1024x1024");
    const quality = String(args.quality || "standard");
    const style = String(args.style || "vivid");

    try {
      // Get API key (same OAuth token used for chat)
      const apiKey = await getApiKey();

      const res = await fetch("https://api.openai.com/v1/images/generations", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: "dall-e-3",
          prompt,
          n: 1,
          size,
          quality,
          style,
          response_format: "url",
        }),
        signal: AbortSignal.timeout(120_000), // 2 min timeout
      });

      if (!res.ok) {
        const errBody = await res.text();
        // Check for specific errors
        if (res.status === 401 || res.status === 403) {
          return err(
            "DALL-E access denied — your OpenAI account may not have image generation enabled. " +
            "Check your OpenAI plan at https://platform.openai.com/account/billing"
          );
        }
        if (res.status === 429) {
          return err("Rate limited — wait a moment and try again.");
        }
        return err(`DALL-E error ${res.status}: ${errBody.slice(0, 300)}`);
      }

      const data = (await res.json()) as {
        data: Array<{ url: string; revised_prompt?: string }>;
      };

      if (!data.data || data.data.length === 0) {
        return err("DALL-E returned no images.");
      }

      const imageUrl = data.data[0].url;
      const revisedPrompt = data.data[0].revised_prompt || prompt;

      // Download and save locally
      const imgRes = await fetch(imageUrl, {
        signal: AbortSignal.timeout(30_000),
      });
      const buffer = Buffer.from(await imgRes.arrayBuffer());

      const imagesDir = join(process.cwd(), "workspace", "images");
      if (!existsSync(imagesDir)) mkdirSync(imagesDir, { recursive: true });

      const safeName = prompt
        .replace(/[^a-zA-Z0-9_-]/g, "_")
        .slice(0, 40);
      const filename = `${safeName}_${Date.now()}.png`;
      const filePath = join(imagesDir, filename);

      writeFileSync(filePath, buffer);

      const localUrl = `http://127.0.0.1:4800/images/${filename}`;

      return ok(
        `Image generated!\n` +
          `Prompt: ${revisedPrompt}\n` +
          `Size: ${size} | Quality: ${quality} | Style: ${style}\n` +
          `View: ${localUrl}\n` +
          `Saved: workspace/images/${filename}`
      );
    } catch (e) {
      const msg = (e as Error).message;
      if (msg.includes("timeout")) {
        return err("Image generation timed out — DALL-E may be busy. Try again.");
      }
      return err(`Image generation failed: ${msg}`);
    }
  },
};

export const imageTools: ToolDefinition[] = [generateImageTool];
