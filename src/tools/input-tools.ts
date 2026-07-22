// The `computer` tool family — OS-level mouse + keyboard control so the agent
// can drive ANY app on the user's desktop (their real browser, native apps),
// not just the Playwright browser. Pairs with screen_capture: screenshot to
// SEE, then move/click/type to ACT.
//
// Actuation lives in input-driver.ts (nut.js). These are the model-facing tool
// definitions; collapseFamily() folds them into a single `computer` tool with
// an `action` enum (same convention as spreadsheet/protocol) so the family
// costs one schema in the per-turn window.
//
// Gating is NOT here: the off-by-default kill-switch is enforced pre-dispatch
// (tool-policy enableComputerControl) and the macOS Accessibility grant is
// enforced in the driver. These tools just validate args and call the driver.

import type { ToolDefinition, ToolResult } from "../types.js";
import { collapseFamily } from "./shared/collapse-family.js";
import {
  clickMouse, dragMouse, getMousePosition, getScreenGeometry, moveMouse, pressKeys, typeText,
  InputAbortError, InputPermissionError, InputUnsupportedError,
  type MouseButton,
} from "./input-driver.js";

const BUTTONS = ["left", "right", "middle"] as const;

function asButton(v: unknown): MouseButton {
  const s = String(v ?? "left").toLowerCase();
  return (BUTTONS as readonly string[]).includes(s) ? (s as MouseButton) : "left";
}

// Map driver errors to the right ToolResult shape. A missing OS permission or
// unsupported platform is `blocked` (retrying the same call WILL fail — the
// model should surface it / pivot), not a plain error.
function fail(e: unknown): ToolResult {
  if (e instanceof InputPermissionError) {
    return {
      content: e.message,
      isError: true,
      status: "blocked",
      metadata: { recovery: "Enable \"Local Agent X\" in System Settings → Privacy & Security → Accessibility, then QUIT AND REOPEN the app (macOS only applies it on restart). Tell the user both steps — granting alone won't work until they restart." },
    };
  }
  if (e instanceof InputUnsupportedError) {
    return { content: e.message, isError: true, status: "blocked" };
  }
  if (e instanceof InputAbortError) {
    return { content: "Input action stopped.", isError: true };
  }
  return { content: `Computer action failed: ${(e as Error).message}`, isError: true };
}

const moveTool: ToolDefinition = {
  name: "computer_move",
  description:
    "Move the mouse cursor to absolute screen coordinates. (x, y) are pixels from the TOP-LEFT of the " +
    "primary display. Take a screen_capture first to see where things are before moving.",
  parameters: {
    type: "object",
    properties: {
      x: { type: "number", description: "Target X in pixels from the left edge" },
      y: { type: "number", description: "Target Y in pixels from the top edge" },
    },
    required: ["x", "y"],
  },
  async execute(args, signal) {
    try {
      const x = Number(args.x), y = Number(args.y);
      await moveMouse(x, y, signal);
      return { content: `Moved cursor to (${x}, ${y}).` };
    } catch (e) { return fail(e); }
  },
};

const clickTool: ToolDefinition = {
  name: "computer_click",
  description:
    "Click the mouse. Optionally pass (x, y) to move there first, then click; omit them to click at the " +
    "current cursor position. button defaults to left; set double:true for a double-click.",
  parameters: {
    type: "object",
    properties: {
      x: { type: "number", description: "Optional X to move to before clicking" },
      y: { type: "number", description: "Optional Y to move to before clicking" },
      button: { type: "string", enum: [...BUTTONS], description: "Mouse button (default: left)" },
      double: { type: "boolean", description: "Double-click instead of single (default: false)" },
    },
    required: [],
  },
  async execute(args, signal) {
    try {
      const x = args.x != null ? Number(args.x) : undefined;
      const y = args.y != null ? Number(args.y) : undefined;
      const button = asButton(args.button);
      const double = Boolean(args.double);
      await clickMouse({ x, y, button, double }, signal);
      const at = x != null && y != null ? ` at (${x}, ${y})` : "";
      return { content: `${double ? "Double-" : ""}${button}-clicked${at}.` };
    } catch (e) { return fail(e); }
  },
};

const dragTool: ToolDefinition = {
  name: "computer_drag",
  description:
    "Press-drag-release from one point to another (holding a mouse button). Use for moving items, " +
    "selecting text/regions, or drawing. Coordinates are absolute pixels from the top-left.",
  parameters: {
    type: "object",
    properties: {
      from_x: { type: "number", description: "Start X" },
      from_y: { type: "number", description: "Start Y" },
      to_x: { type: "number", description: "End X" },
      to_y: { type: "number", description: "End Y" },
      button: { type: "string", enum: [...BUTTONS], description: "Button to hold during the drag (default: left)" },
    },
    required: ["from_x", "from_y", "to_x", "to_y"],
  },
  async execute(args, signal) {
    try {
      const from = { x: Number(args.from_x), y: Number(args.from_y) };
      const to = { x: Number(args.to_x), y: Number(args.to_y) };
      await dragMouse(from, to, asButton(args.button), signal);
      return { content: `Dragged from (${from.x}, ${from.y}) to (${to.x}, ${to.y}).` };
    } catch (e) { return fail(e); }
  },
};

const typeTool: ToolDefinition = {
  name: "computer_type",
  description:
    "Type a string of text into whatever app/field currently has focus, as real keystrokes (Unicode " +
    "supported). Use this for entering text, NOT for shortcuts — use press for chords like Cmd+S.",
  parameters: {
    type: "object",
    properties: {
      text: { type: "string", description: "The text to type" },
    },
    required: ["text"],
  },
  async execute(args, signal) {
    try {
      const text = String(args.text ?? "");
      await typeText(text, signal);
      return { content: `Typed ${text.length} character${text.length === 1 ? "" : "s"}.` };
    } catch (e) { return fail(e); }
  },
};

const pressTool: ToolDefinition = {
  name: "computer_press",
  description:
    "Press one or more keys together as a chord (e.g. [\"cmd\",\"s\"] to save, [\"cmd\",\"space\"] for Spotlight, " +
    "[\"enter\"], [\"tab\"], [\"cmd\",\"shift\",\"t\"]). On Windows use \"ctrl\" where macOS uses \"cmd\". For repeated " +
    "taps call press multiple times. Valid keys: letters, digits, f1-f12, cmd/ctrl/alt/shift, enter, tab, esc, " +
    "space, backspace, delete, arrows, home, end, pageup, pagedown.",
  parameters: {
    type: "object",
    properties: {
      keys: { type: "array", items: { type: "string" }, description: "Keys to press together as one chord" },
    },
    required: ["keys"],
  },
  async execute(args, signal) {
    try {
      const keys = Array.isArray(args.keys) ? args.keys.map(String) : [];
      if (keys.length === 0) return { content: "No keys given to press.", isError: true };
      await pressKeys(keys, signal);
      return { content: `Pressed ${keys.join("+")}.` };
    } catch (e) { return fail(e); }
  },
};

const positionTool: ToolDefinition = {
  name: "computer_position",
  description: "Get the current mouse cursor position (x, y) in screen pixels. Reads only — no permission needed.",
  parameters: { type: "object", properties: {}, required: [] },
  async execute() {
    try {
      const { x, y } = await getMousePosition();
      return { content: `Cursor is at (${x}, ${y}).` };
    } catch (e) { return fail(e); }
  },
};

const screenSizeTool: ToolDefinition = {
  name: "computer_screen_size",
  description:
    "Get the display layout in the SAME pixel space move/click/drag use. Call this BEFORE centering or any " +
    "absolute positioning — NEVER assume 1920x1080; Retina/scaled displays differ and guessing puts the cursor " +
    "in the wrong place. On MULTI-MONITOR setups this returns every monitor's rect: a secondary monitor sits at " +
    "an OFFSET (often NEGATIVE x/y) from the primary's top-left origin, and those offsets are exactly what " +
    "move/click expect. When you screen_capture monitor N and see a target, add that monitor's (x,y) offset to " +
    "the in-image coordinates before moving.",
  parameters: { type: "object", properties: {}, required: [] },
  async execute() {
    try {
      const geo = await getScreenGeometry();
      const p = geo.primary;
      if (geo.monitors.length <= 1) {
        return { content: `Screen is ${p.width}x${p.height}px. Center is (${Math.round(p.x + p.width / 2)}, ${Math.round(p.y + p.height / 2)}).` };
      }
      const lines = geo.monitors
        .map((m) => `  monitor ${m.index}${m.primary ? " (primary)" : ""}: ${m.width}x${m.height} at top-left (${m.x}, ${m.y}), center (${Math.round(m.x + m.width / 2)}, ${Math.round(m.y + m.height / 2)})`)
        .join("\n");
      const v = geo.virtual;
      return {
        content:
          `${geo.monitors.length} monitors. Coordinates are absolute across the whole virtual desktop ` +
          `(bounds ${v.width}x${v.height}, top-left (${v.x}, ${v.y})). Secondary monitors are offset from the ` +
          `primary — use each monitor's own top-left when aiming there:\n${lines}`,
      };
    } catch (e) { return fail(e); }
  },
};

export const computerTool: ToolDefinition = collapseFamily({
  name: "computer",
  intro:
    "Control the real mouse and keyboard to operate ANY app on the user's desktop (their browser, native " +
    "apps, the OS itself) — not just the in-app browser. Workflow: screen_capture to SEE the screen, then " +
    "move/click/type/press to ACT, then screen_capture again to verify. Coordinates are absolute pixels across " +
    "the whole virtual desktop — call action:'screen_size' FIRST to get the real dimensions, per-monitor layout, " +
    "and center; NEVER assume 1920x1080 (Retina/scaled displays differ, and guessing lands the cursor wrong). " +
    "MULTI-MONITOR: a second monitor is offset (often NEGATIVE x/y) from the primary; add that monitor's top-left " +
    "offset (from screen_size) to what you see in its screenshot before moving/clicking. " +
    "For web pages where you have a snapshot with refs, prefer the " +
    "`browser` tool — it's more precise than coordinate clicks. " +
    "While this session has a live in-app browser view open, coordinate actions (move/click/drag) WITHOUT " +
    "target:'os-desktop' are DENIED: the in-app page must be driven with `browser` refs, never with pixels " +
    "guessed off a monitor capture. Pass target:'os-desktop' only when operating a DIFFERENT desktop app.",
  actions: {
    screen_size: screenSizeTool,
    move: moveTool,
    click: clickTool,
    drag: dragTool,
    type: typeTool,
    press: pressTool,
    position: positionTool,
  },
  properties: {
    x: { type: "number", description: "X in pixels from the left (move/click)" },
    y: { type: "number", description: "Y in pixels from the top (move/click)" },
    button: { type: "string", enum: [...BUTTONS], description: "Mouse button (click/drag; default left)" },
    double: { type: "boolean", description: "Double-click (click)" },
    from_x: { type: "number", description: "Drag start X" },
    from_y: { type: "number", description: "Drag start Y" },
    to_x: { type: "number", description: "Drag end X" },
    to_y: { type: "number", description: "Drag end Y" },
    text: { type: "string", description: "Text to type (type)" },
    keys: { type: "array", items: { type: "string" }, description: "Keys to press together (press)" },
    target: {
      type: "string",
      enum: ["os-desktop"],
      description:
        "Explicit override required for coordinate actions (move/click/drag) while this session has a live " +
        "in-app browser view: without it those are denied (drive the in-app page with `browser` refs instead). " +
        "Pass 'os-desktop' ONLY when operating another desktop app — never to click on the in-app browser pane.",
    },
  },
});
