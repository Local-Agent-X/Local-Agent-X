import { existsSync } from "node:fs";
import { resolve } from "node:path";
import type { ToolDefinition } from "../types.js";

export const viewImageTool: ToolDefinition = {
  name: "view_image",
  description:
    "View/analyze a local image file. Reads the image from disk and returns it for visual analysis. " +
    "Use this when the user asks you to look at, review, or analyze an image file on their computer. " +
    "Supports: jpg, jpeg, png, gif, webp, bmp.",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "Path to the image file (absolute or relative)" },
      question: { type: "string", description: "What to analyze about the image (default: describe it)" },
    },
    required: ["path"],
  },
  async execute(args) {
    const { resolve } = await import("node:path");
    const { readFileSync, existsSync } = await import("node:fs");

    const filePath = resolve(String(args.path));
    if (!existsSync(filePath)) return { content: `File not found: ${filePath}`, isError: true };

    const ext = filePath.split(".").pop()?.toLowerCase() || "";
    const imageExts = new Set(["jpg", "jpeg", "png", "gif", "webp", "bmp"]);
    if (!imageExts.has(ext)) return { content: `Not an image file: .${ext}`, isError: true };

    try {
      const data = readFileSync(filePath);
      const mime = ext === "jpg" ? "image/jpeg" : `image/${ext}`;
      const b64 = data.toString("base64");
      const question = String(args.question || "Describe this image in detail.");

      return {
        content: `[IMAGE:${mime}:${b64.slice(0, 100)}...${b64.length} bytes]\nFile: ${filePath}\nQuestion: ${question}\n\nPlease analyze this image.`,
        _image: { mime, b64, path: filePath, question },
      } as any;
    } catch (e) {
      return { content: `Failed to read image: ${(e as Error).message}`, isError: true };
    }
  },
};

export const screenCaptureTool: ToolDefinition = {
  name: "screen_capture",
  description:
    "Screenshot the user's PHYSICAL MONITOR (Windows desktop, their apps, their taskbar). " +
    "ONLY for looking at the user's own screen / desktop apps / windows outside our browser. " +
    "DO NOT use for web pages, URLs, or sites you want to read or interact with — for ANY " +
    "website/web-app task (DNS setup, form filling, login, reading a page) use `browser` with " +
    "action:'snapshot' instead. browser's snapshot gives structured refs you can click/fill; " +
    "screen_capture just gives a flat image with no interaction handles. " +
    "If the user mentions a non-primary display (\"second screen\", \"other monitor\", \"my laptop screen\"), " +
    "OR if the app they want isn't on monitor 0, call `list_monitors` FIRST to see what's connected, " +
    "then pass the right `monitor` index. Do NOT guess monitor:0 when the user hints at a different screen.",
  parameters: {
    type: "object",
    properties: {
      monitor: { type: "number", description: "Monitor index, 0-based. 0 = first detected, 1 = second, etc. The PRIMARY display is not always index 0 — call list_monitors first to see which index is primary and which physical screen each index maps to. OMIT this field to capture the primary display by default." },
      region: {
        type: "object",
        description: "ADVANCED: capture a sub-region of the screen. OMIT this entirely for a full-screen capture. Do NOT include this field with zeros or placeholder values — only include it when the user explicitly wants a specific rectangle. width and height MUST both be > 0 if provided.",
        properties: {
          x: { type: "number", description: "Left edge in pixels" },
          y: { type: "number", description: "Top edge in pixels" },
          width: { type: "number", description: "Region width in pixels (must be > 0)" },
          height: { type: "number", description: "Region height in pixels (must be > 0)" },
        },
        required: ["x", "y", "width", "height"],
      },
      scale: { type: "number", description: "Scale factor 0.1-1.0 to reduce image size (default 0.5). Lower = smaller file." },
      question: { type: "string", description: "What to analyze about the screen (default: describe it)" },
    },
    required: [],
  },
  async execute(args) {
    try {
      const { captureScreen } = await import("../screen-capture.js");
      const scale = Math.min(1, Math.max(0.1, Number(args.scale) || 0.5));
      const result = captureScreen({
        monitor: args.monitor != null ? Number(args.monitor) : undefined,
        region: args.region as any,
        format: "jpg",
        quality: 80,
        scale,
      });
      const b64 = result.image.toString("base64");
      const question = String(args.question || "Describe what's on the screen.");
      return {
        content: `[IMAGE:image/jpeg:${b64.slice(0, 100)}...${b64.length} bytes]\nScreen capture: ${result.width}x${result.height}\nQuestion: ${question}\n\nPlease analyze this screenshot.`,
        _image: { mime: "image/jpeg", b64, path: "screen-capture", question },
      } as any;
    } catch (e) {
      return { content: `Screen capture failed: ${(e as Error).message}`, isError: true };
    }
  },
};

export const listMonitorsTool: ToolDefinition = {
  name: "list_monitors",
  description:
    "List physical monitors connected to the user's machine. Returns each monitor's 0-based " +
    "index, device name, resolution, and whether it's the primary. Call this BEFORE screen_capture " +
    "when the user references a non-primary display (e.g. 'second screen', 'my laptop', 'other monitor') " +
    "so you know which `monitor` index to target.",
  parameters: { type: "object", properties: {}, required: [] },
  async execute() {
    try {
      const { listMonitors } = await import("../screen-capture.js");
      const monitors = listMonitors();
      if (monitors.length === 0) return { content: "No monitors detected." };
      const lines = monitors.map(m =>
        `${m.index}: ${m.name} — ${m.width}x${m.height}${m.primary ? " (PRIMARY)" : ""}`
      );
      return { content: `Monitors (${monitors.length}):\n${lines.join("\n")}` };
    } catch (e) {
      return { content: `list_monitors failed: ${(e as Error).message}`, isError: true };
    }
  },
};

export const cameraCaptureTool: ToolDefinition = {
  name: "camera_capture",
  description:
    "Take a photo from the webcam. Returns the image for visual analysis. " +
    "Use this when the user asks you to see them, take a photo, or use the camera.",
  parameters: {
    type: "object",
    properties: {
      device: { type: "string", description: "Video device name (auto-detected if omitted)" },
      question: { type: "string", description: "What to analyze about the image (default: describe it)" },
    },
    required: [],
  },
  async execute(args) {
    try {
      const { captureFrame } = await import("../camera-tool.js");
      const result = captureFrame({
        device: args.device ? String(args.device) : undefined,
        format: "jpg",
        quality: 85,
      });
      const b64 = result.image.toString("base64");
      const question = String(args.question || "Describe what you see.");
      return {
        content: `[IMAGE:image/jpeg:${b64.slice(0, 100)}...${b64.length} bytes]\nCamera: ${result.deviceName} (${result.width}x${result.height})\nQuestion: ${question}\n\nPlease analyze this image.`,
        _image: { mime: "image/jpeg", b64, path: "camera-capture", question },
      } as any;
    } catch (e) {
      return { content: `Camera capture failed: ${(e as Error).message}`, isError: true };
    }
  },
};

export const ocrTool: ToolDefinition = {
  name: "ocr",
  description:
    "Extract text from an image using OCR (Tesseract). " +
    "Use this when the user asks to read text from an image, screenshot, or photo.",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "Path to the image file" },
      language: { type: "string", description: "OCR language (default: eng). Use eng+fra for multi-language." },
    },
    required: ["path"],
  },
  async execute(args) {
    try {
      const filePath = resolve(String(args.path));
      if (!existsSync(filePath)) return { content: `File not found: ${filePath}`, isError: true };
      const { recognizeTextNative, recognizeText } = await import("../ocr-tool.js");
      let result;
      try {
        result = recognizeTextNative(filePath, { language: args.language ? String(args.language) : undefined });
      } catch {
        result = await recognizeText(filePath, { language: args.language ? String(args.language) : undefined });
      }
      if (!result.text) return { content: "No text detected in image.", isError: false };
      return { content: `OCR Result (${result.processingMs}ms, lang=${result.language}):\n\n${result.text}` };
    } catch (e) {
      return { content: `OCR failed: ${(e as Error).message}`, isError: true };
    }
  },
};
