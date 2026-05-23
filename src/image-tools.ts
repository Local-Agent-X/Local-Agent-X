/**
 * Image / video generation tools — aggregator.
 *
 * The 2 tool definitions live in src/image-tools/:
 *   generate-image.ts — generate_image (xAI / OpenAI / local SD)
 *   generate-video.ts — generate_video (xAI Grok Imagine / local CogVideoX)
 *   shared.ts         — provider resolution, ok/err, recent-image fallback
 */

import type { ToolDefinition } from "./types.js";
import { generateImageTool } from "./image-tools/generate-image.js";
import { generateVideoTool } from "./image-tools/generate-video.js";

export { initImageTools } from "./image-tools/shared.js";

export const imageTools: ToolDefinition[] = [generateImageTool, generateVideoTool];
