// LLM-driven particle visualizer. The agent calls this tool to morph the
// on-screen particle sphere into an emoji, short text, geometric shape, or
// mood preset. Frontend listens for the `visual` ServerEvent and lerps the
// dust cloud to match.
//
// The voice state machine still owns baseline animation (amplitude,
// rotation, glow). This tool only changes WHERE particles are heading,
// not their per-frame liveliness.

import type { ToolDefinition, ToolResult, ServerEvent } from "../types.js";

const ALLOWED_KINDS = new Set(["emoji", "text", "shape", "mood"]);
const ALLOWED_SHAPES = new Set(["heart", "lightning", "ring", "spiral", "line"]);
const ALLOWED_MOODS = new Set(["happy", "sad", "thinking", "confused", "excited", "error"]);
const MIN_DURATION_MS = 500;
const MAX_DURATION_MS = 6000;
const DEFAULT_DURATION_MS = 3600;
const MAX_TEXT_CHARS = 32;
const MAX_EMOJI_CODEPOINTS = 4;

function err(content: string): ToolResult {
  return { content, isError: true };
}

function ok(content: string): ToolResult {
  return { content };
}

function countCodepoints(s: string): number {
  let n = 0;
  for (const _ of s) n++;
  return n;
}

export function createVoiceVisualTool(): ToolDefinition {
  return {
    name: "voice_visual",
    description:
      "Render a transient visual on the user's particle sphere. Use whenever " +
      "an emoji, short word, shape, or mood would land. Never narrate the " +
      "call (\"let me show you\"); just call it.",
    readOnly: true,
    parameters: {
      type: "object",
      properties: {
        kind: {
          type: "string",
          enum: ["emoji", "text", "shape", "mood"],
          description:
            "emoji = single emoji glyph forming in dust. " +
            "text = short word ≤32 chars (e.g. \"yes!\", \"wow\"). " +
            "shape = geometric form (heart, lightning, ring, spiral, line). " +
            "mood = preset emotional composition (happy, sad, thinking, confused, excited, error).",
        },
        value: {
          type: "string",
          description:
            "For kind=emoji: the emoji character itself (1-4 codepoints). " +
            "For kind=text: a short string ≤32 chars. " +
            "For kind=shape: one of heart, lightning, ring, spiral, line. " +
            "For kind=mood: one of happy, sad, thinking, confused, excited, error.",
        },
        duration_ms: {
          type: "number",
          description: "How long to hold the form (500-6000ms). Default 3600.",
        },
      },
      required: ["kind", "value"],
    },
    async execute(args: Record<string, unknown>): Promise<ToolResult> {
      const onEvent = args._onEvent as ((e: ServerEvent) => void) | undefined;

      const kind = String(args.kind || "");
      if (!ALLOWED_KINDS.has(kind)) {
        return err(`invalid kind "${kind}". allowed: emoji, text, shape, mood`);
      }
      const value = String(args.value || "").trim();
      if (!value) return err("value required");
      if (kind === "text" && value.length > MAX_TEXT_CHARS) {
        return err(`text too long (${value.length} > ${MAX_TEXT_CHARS} chars)`);
      }
      if (kind === "emoji") {
        const cp = countCodepoints(value);
        if (cp < 1 || cp > MAX_EMOJI_CODEPOINTS) {
          return err(`emoji must be 1-${MAX_EMOJI_CODEPOINTS} codepoints, got ${cp}`);
        }
      }
      if (kind === "shape" && !ALLOWED_SHAPES.has(value)) {
        return err(`invalid shape "${value}". allowed: ${[...ALLOWED_SHAPES].join(", ")}`);
      }
      if (kind === "mood" && !ALLOWED_MOODS.has(value)) {
        return err(`invalid mood "${value}". allowed: ${[...ALLOWED_MOODS].join(", ")}`);
      }

      // Clamp duration
      let durationMs = Math.round(Number(args.duration_ms || DEFAULT_DURATION_MS));
      if (!Number.isFinite(durationMs)) durationMs = DEFAULT_DURATION_MS;
      durationMs = Math.max(MIN_DURATION_MS, Math.min(MAX_DURATION_MS, durationMs));

      // Fire the side-effect event. The browser receives this via the chat
      // or voice WebSocket and morphs the particle sphere. Tool return is
      // "ok" — kept intentionally short so the LLM has nothing tempting to
      // echo aloud.
      if (onEvent) {
        onEvent({ type: "visual", kind: kind as "emoji" | "text" | "shape" | "mood", value, durationMs });
      }
      return ok("ok");
    },
  };
}
