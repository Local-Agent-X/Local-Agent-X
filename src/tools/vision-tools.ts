import { existsSync } from "node:fs";
import type { ToolDefinition } from "../types.js";
import { createLogger } from "../logger.js";
// Resolve caller paths the SAME way SecurityLayer's file-access gate does
// (project-root anchored, no ~ expansion) so the gated path == the opened path.
import { resolveAgentPath } from "../workspace/paths.js";

const logger = createLogger("tools.vision");

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
    const { readFileSync, existsSync } = await import("node:fs");

    const filePath = resolveAgentPath(String(args.path));
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

const VIDEO_EXTS = new Set(["mp4", "mov", "webm", "mkv", "avi", "m4v"]);
const VIDEO_MIME: Record<string, string> = {
  mp4: "video/mp4", m4v: "video/mp4", mov: "video/quicktime",
  webm: "video/webm", mkv: "video/x-matroska", avi: "video/x-msvideo",
};

export const sendVideoTool: ToolDefinition = {
  name: "send_video",
  description:
    "Send a video file from this computer to the user over the current messaging channel (WhatsApp/Telegram). " +
    "Use when the user asks you to send or share a video file with them. Only delivers on a messaging bridge — " +
    "on web chat the user is already at the computer with the file. Supports mp4, mov, webm, mkv, avi. " +
    "WhatsApp caps at 16MB, Telegram at 50MB.",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "Path to the video file (absolute or relative)" },
    },
    required: ["path"],
  },
  async execute(args) {
    const { existsSync, statSync } = await import("node:fs");

    const filePath = resolveAgentPath(String(args.path || ""));
    if (!existsSync(filePath)) return { content: `File not found: ${filePath}`, isError: true };

    const ext = filePath.split(".").pop()?.toLowerCase() || "";
    if (!VIDEO_EXTS.has(ext)) return { content: `Not a video file: .${ext}. Supported: ${[...VIDEO_EXTS].join(", ")}.`, isError: true };

    const sizeMb = statSync(filePath).size / 1048576;
    if (sizeMb > 50) return { content: `Video is ${sizeMb.toFixed(1)}MB — over the 50MB messaging limit, can't send.`, isError: true };

    logger.info(`[send_video] ${filePath} (${sizeMb.toFixed(1)}MB)`);
    return {
      content: `Sending video to the user: ${filePath} (${sizeMb.toFixed(1)}MB).`,
      _media: { kind: "video", path: filePath, mime: VIDEO_MIME[ext] || "video/mp4" },
    };
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
      monitor: { type: "number", description: "Monitor index, 0-BASED. CRITICAL: when the user says 'monitor 1' / 'first monitor' they mean index 0; 'monitor 2' / 'second monitor' = index 1. ALWAYS subtract 1 from the user's natural-language number. The PRIMARY display is not always index 0 — call list_monitors first to see which index is primary and which physical screen each index maps to. OMIT this field to capture the primary display by default." },
      region: {
        type: "object",
        description: "ADVANCED — almost never needed. OMIT this field for a full-screen capture (which is what the user wants 99% of the time). When present, captures a sub-rectangle. Coords are RELATIVE to the chosen `monitor`'s top-left (NOT global virtual-screen coords). If `monitor` is omitted, region is relative to the primary screen. Do NOT include this field with zeros, placeholders, or values that span the whole screen — those are signs you should be omitting it. width and height MUST both be > 0 if provided.",
        properties: {
          x: { type: "number", description: "Left edge in pixels, relative to the chosen monitor" },
          y: { type: "number", description: "Top edge in pixels, relative to the chosen monitor" },
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
      const { captureScreen, listMonitors } = await import("../screen-capture.js");
      const scale = Math.min(1, Math.max(0.1, Number(args.scale) || 0.5));
      const monitorArg = args.monitor != null ? Number(args.monitor) : undefined;
      logger.info(`[screen_capture] monitor=${monitorArg ?? "<primary>"} scale=${scale} region=${args.region ? "set" : "none"}`);
      const result = captureScreen({
        monitor: monitorArg,
        region: args.region as any,
        format: "jpg",
        quality: 80,
        scale,
      });
      // Resolve which monitor was actually captured. listMonitors() so the
      // tool result tells the agent which physical screen it just saw + the
      // full list of OTHER monitors available — without this metadata the
      // agent has no way to know whether monitor=0 was the laptop screen
      // or the external display, and on subsequent "show me the OTHER
      // monitor" requests it has to guess. The WhatsApp-vs-Telegram bug
      // ("WhatsApp shows the same image for monitor 1 vs 2") was the
      // agent guessing wrong because there was no monitor context in the
      // tool result. Telegram only worked because earlier turns had
      // accumulated list_monitors output in conversation history; a fresh
      // WhatsApp session lacked that context.
      let captureMeta = "";
      try {
        const monitors = listMonitors();
        const captured = (monitorArg != null)
          ? monitors.find(m => m.index === monitorArg)
          : monitors.find(m => m.primary);
        if (captured) {
          captureMeta = `Captured Monitor ${captured.index + 1} (tool index=${captured.index}) — ${captured.name}${captured.primary ? " (PRIMARY)" : ""} ${captured.width}x${captured.height}.`;
        }
        if (monitors.length > 1) {
          const others = monitors
            .filter(m => m.index !== captured?.index)
            .map(m => `Monitor ${m.index + 1} (tool index=${m.index}): ${m.name}${m.primary ? " (primary)" : ""} ${m.width}x${m.height}`)
            .join("; ");
          if (others) captureMeta += ` Other monitors: ${others}.`;
        }
      } catch { /* metadata is best-effort — never break the capture */ }
      const b64 = result.image.toString("base64");
      const question = String(args.question || "Describe what's on the screen.");
      return {
        content: `[IMAGE:image/jpeg:${b64.slice(0, 100)}...${b64.length} bytes]\n${captureMeta}\nScreen capture: ${result.width}x${result.height}\nQuestion: ${question}\n\nPlease analyze this screenshot.`,
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
    "List physical monitors connected to the user's machine. Returns each monitor with both " +
    "its user-facing label ('Monitor 1', 'Monitor 2') AND its 0-based tool index. Call this " +
    "BEFORE screen_capture when the user references a non-primary display (e.g. 'second screen', " +
    "'my laptop', 'other monitor') so you know which 0-based `monitor` index to target.",
  parameters: { type: "object", properties: {}, required: [] },
  async execute() {
    try {
      const { listMonitors } = await import("../screen-capture.js");
      const monitors = listMonitors();
      if (monitors.length === 0) return { content: "No monitors detected." };
      // Show BOTH the 1-based label users say in natural language AND the
      // 0-based index the tool wants. Without the dual labeling the agent
      // routinely passed `monitor=1` for "monitor 1" and got monitor index
      // 1 (the second physical screen) instead of index 0 — the visible
      // failure was "asked for monitor 1, got monitor 2" until the user
      // realized they needed to subtract 1.
      const lines = monitors.map(m =>
        `Monitor ${m.index + 1} (tool index=${m.index}): ${m.name} — ${m.width}x${m.height}${m.primary ? " (PRIMARY)" : ""}`
      );
      return {
        content:
          `Monitors (${monitors.length}):\n${lines.join("\n")}\n\n` +
          `When passing the \`monitor\` arg to screen_capture, use the 0-based "tool index" above. ` +
          `User says "monitor 1" → pass \`monitor: 0\`. User says "monitor 2" → pass \`monitor: 1\`.`,
      };
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
      const { captureFrame } = await import("./camera-tool.js");
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
      const filePath = resolveAgentPath(String(args.path));
      if (!existsSync(filePath)) return { content: `File not found: ${filePath}`, isError: true };
      const { recognizeTextNative, recognizeText } = await import("./ocr-tool.js");
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
