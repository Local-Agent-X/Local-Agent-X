// OS-level mouse + keyboard actuation via nut.js (@nut-tree-fork/nut-js).
//
// Runs IN the server process — the same place screen_capture spawns ffmpeg —
// NOT Electron main. nut.js ships prebuilt N-API binaries per platform
// (libnut-darwin/-win32), so there's no node-gyp/Xcode/VS build step; it
// installs like any other dep and loads under the system Node the desktop
// spawns the server with (see desktop/src/server-process.ts).
//
// nut.js is imported LAZILY (await import) so the native addon — and its macOS
// "wants accessibility access" warning — only load the first time the agent
// actually drives input, never at server boot.
//
// This module does NOT decide whether input control is ALLOWED: the off-by-
// default kill-switch lives in tool-policy (pre-dispatch) and the OS grant in
// System Settings. The driver only (a) refuses on an unsupported OS, (b)
// refuses when the macOS Accessibility grant is missing — so an ungranted call
// fails loud instead of silently doing nothing — and (c) honors the run
// AbortSignal so the panic hotkey can halt an in-flight action.

import { createLogger } from "../logger.js";

const logger = createLogger("tools.input");

export type MouseButton = "left" | "right" | "middle";

// nut.js handle, loaded + configured once on first use.
let _nut: typeof import("@nut-tree-fork/nut-js") | null = null;

async function nut(): Promise<typeof import("@nut-tree-fork/nut-js")> {
  if (_nut) return _nut;
  const mod = await import("@nut-tree-fork/nut-js");
  // Fluid-but-reliable defaults: a smooth glide (not an instant teleport,
  // which looks jarring and can drop hover/drag targets) plus a small inter-
  // action delay so fast key/click bursts aren't swallowed by the target app.
  mod.mouse.config.mouseSpeed = 1200; // px/sec
  mod.mouse.config.autoDelayMs = 30;
  mod.keyboard.config.autoDelayMs = 6;
  _nut = mod;
  return mod;
}

export class InputAbortError extends Error {
  constructor() { super("Input action aborted by stop request."); this.name = "InputAbortError"; }
}
export class InputPermissionError extends Error {
  constructor(message: string) { super(message); this.name = "InputPermissionError"; }
}
export class InputUnsupportedError extends Error {
  constructor() { super("Computer control is only supported on macOS and Windows."); this.name = "InputUnsupportedError"; }
}

function assertSupportedOS(): void {
  if (process.platform !== "darwin" && process.platform !== "win32") {
    throw new InputUnsupportedError();
  }
}

function checkAbort(signal?: AbortSignal): void {
  if (signal?.aborted) throw new InputAbortError();
}

// macOS gates SYNTHETIC input behind the Accessibility (TCC) permission, and
// that grant attaches to whichever process posts the event (here: the server's
// `node`). We read the status via the node-mac-permissions helper bundled with
// nut.js. Windows synthesizes input through SendInput with no permission gate,
// so the preflight is darwin-only and returns "authorized" elsewhere.
export type InputPermission = "authorized" | "denied" | "not-determined" | "unsupported";

export async function inputPermissionStatus(): Promise<InputPermission> {
  if (process.platform === "win32") return "authorized"; // no per-app gate
  if (process.platform !== "darwin") return "unsupported";
  try {
    const { createRequire } = await import("node:module");
    const require = createRequire(import.meta.url);
    const perms = require("@nut-tree-fork/node-mac-permissions");
    const status = String(perms.getAuthStatus("accessibility"));
    if (status === "authorized") return "authorized";
    if (status === "denied" || status === "restricted") return "denied";
    return "not-determined";
  } catch (e) {
    logger.warn(`[input] accessibility status check failed: ${(e as Error).message}`);
    return "not-determined";
  }
}

async function assertPermission(): Promise<void> {
  const status = await inputPermissionStatus();
  if (status !== "authorized") {
    throw new InputPermissionError(
      "macOS hasn't granted Accessibility to Local Agent X (or it was granted while the app " +
      "was already running). Enable \"Local Agent X\" in System Settings → Privacy & Security → " +
      "Accessibility, then QUIT AND REOPEN the app — macOS only applies the permission on restart.",
    );
  }
}

function toButton(mod: typeof import("@nut-tree-fork/nut-js"), button: MouseButton) {
  const { Button } = mod;
  return button === "right" ? Button.RIGHT : button === "middle" ? Button.MIDDLE : Button.LEFT;
}

// Reading the cursor needs no Accessibility grant (it doesn't post an event),
// so this is the one action without a permission preflight.
export async function getMousePosition(): Promise<{ x: number; y: number }> {
  assertSupportedOS();
  const { mouse } = await nut();
  const p = await mouse.getPosition();
  return { x: p.x, y: p.y };
}

// Screen size in the SAME coordinate space move/click/drag use (nut.js/libnut),
// so the agent centers/positions correctly instead of assuming 1920x1080. Pure
// geometry query — no Screen-Recording grant needed.
export async function getScreenSize(): Promise<{ width: number; height: number }> {
  assertSupportedOS();
  const { screen } = await nut();
  return { width: await screen.width(), height: await screen.height() };
}

export async function moveMouse(x: number, y: number, signal?: AbortSignal): Promise<void> {
  assertSupportedOS();
  await assertPermission();
  checkAbort(signal);
  const mod = await nut();
  await mod.mouse.move(mod.straightTo(new mod.Point(x, y)));
}

// Instant cursor placement (no glide) — the right primitive for live remote
// control, where the cursor must track the finger 1:1. moveMouse() glides, which
// is good for the agent but lags a high-frequency input stream.
export async function setMousePosition(x: number, y: number, signal?: AbortSignal): Promise<void> {
  assertSupportedOS();
  await assertPermission();
  checkAbort(signal);
  const mod = await nut();
  await mod.mouse.setPosition(new mod.Point(x, y));
}

export async function clickMouse(
  opts: { x?: number; y?: number; button?: MouseButton; double?: boolean },
  signal?: AbortSignal,
): Promise<void> {
  assertSupportedOS();
  await assertPermission();
  checkAbort(signal);
  const mod = await nut();
  if (opts.x != null && opts.y != null) {
    await mod.mouse.move(mod.straightTo(new mod.Point(opts.x, opts.y)));
  }
  checkAbort(signal);
  const button = toButton(mod, opts.button ?? "left");
  if (opts.double) await mod.mouse.doubleClick(button);
  else await mod.mouse.click(button);
}

export async function dragMouse(
  from: { x: number; y: number },
  to: { x: number; y: number },
  button: MouseButton,
  signal?: AbortSignal,
): Promise<void> {
  assertSupportedOS();
  await assertPermission();
  checkAbort(signal);
  const mod = await nut();
  const btn = toButton(mod, button);
  await mod.mouse.setPosition(new mod.Point(from.x, from.y));
  checkAbort(signal);
  await mod.mouse.pressButton(btn);
  try {
    await mod.mouse.move(mod.straightTo(new mod.Point(to.x, to.y)));
  } finally {
    // Always release the button — a thrown abort mid-drag must not leave the
    // mouse button stuck down.
    await mod.mouse.releaseButton(btn);
  }
}

// Press (and hold) / release a button at the current cursor position — the
// brackets of an interactive drag the screen-stream remote-control drives. The
// agent's drag uses dragMouse() (a single glide); the phone needs press/move/
// release split so a finger-drag follows the path.
export async function pressButton(button: MouseButton, signal?: AbortSignal): Promise<void> {
  assertSupportedOS();
  await assertPermission();
  checkAbort(signal);
  const mod = await nut();
  await mod.mouse.pressButton(toButton(mod, button));
}

export async function releaseButton(button: MouseButton, signal?: AbortSignal): Promise<void> {
  assertSupportedOS();
  await assertPermission();
  checkAbort(signal);
  const mod = await nut();
  await mod.mouse.releaseButton(toButton(mod, button));
}

// Scroll by tick counts: +dy scrolls down, +dx scrolls right (screen-space, the
// direction the content moves under a wheel). Zero deltas are no-ops.
export async function scroll(dx: number, dy: number, signal?: AbortSignal): Promise<void> {
  assertSupportedOS();
  await assertPermission();
  checkAbort(signal);
  const { mouse } = await nut();
  if (dy > 0) await mouse.scrollDown(dy);
  else if (dy < 0) await mouse.scrollUp(-dy);
  checkAbort(signal);
  if (dx > 0) await mouse.scrollRight(dx);
  else if (dx < 0) await mouse.scrollLeft(-dx);
}

export async function typeText(text: string, signal?: AbortSignal): Promise<void> {
  assertSupportedOS();
  await assertPermission();
  checkAbort(signal);
  const { keyboard } = await nut();
  await keyboard.type(text);
}

// Press `keyNames` together as ONE chord (modifiers held while the final key is
// struck, e.g. ["cmd","shift","t"]) — not sequential taps. For repeated taps
// (Tab Tab Tab) the caller invokes press multiple times.
export async function pressKeys(keyNames: string[], signal?: AbortSignal): Promise<void> {
  assertSupportedOS();
  await assertPermission();
  checkAbort(signal);
  const mod = await nut();
  const keys = keyNames.map((k) => resolveKey(mod, k));
  // resolveKey resolves enum members dynamically (string → numeric Key), so
  // re-type the variadic methods to accept the numeric values.
  const kb = mod.keyboard as unknown as {
    pressKey: (...k: number[]) => Promise<unknown>;
    releaseKey: (...k: number[]) => Promise<unknown>;
  };
  await kb.pressKey(...keys);
  await kb.releaseKey(...[...keys].reverse());
}

// User-facing key name → nut.js Key enum member name. Single letters (a-z) and
// digits (0-9) are resolved dynamically below, so only named/aliased keys live
// here. Aliases (cmd/win/option/esc/…) map the words a model naturally emits.
const KEY_ALIASES: Record<string, string> = {
  cmd: "LeftCmd", command: "LeftCmd", meta: "LeftCmd", super: "LeftCmd", win: "LeftCmd", windows: "LeftCmd",
  ctrl: "LeftControl", control: "LeftControl",
  alt: "LeftAlt", option: "LeftAlt", opt: "LeftAlt",
  shift: "LeftShift",
  enter: "Return", return: "Return",
  tab: "Tab", esc: "Escape", escape: "Escape", space: "Space", spacebar: "Space",
  backspace: "Backspace", delete: "Delete", del: "Delete",
  up: "Up", down: "Down", left: "Left", right: "Right",
  home: "Home", end: "End", pageup: "PageUp", pagedown: "PageDown",
  capslock: "CapsLock", insert: "Insert", print: "Print", scrolllock: "ScrollLock", pause: "Pause",
  minus: "Minus", equal: "Equal", comma: "Comma", period: "Period", slash: "Slash",
  semicolon: "Semicolon", quote: "Quote", backtick: "Grave", grave: "Grave",
  leftbracket: "LeftBracket", rightbracket: "RightBracket", backslash: "Backslash",
};

function resolveKey(mod: typeof import("@nut-tree-fork/nut-js"), name: string) {
  const { Key } = mod as unknown as { Key: Record<string, number> };
  const raw = name.trim();
  const lower = raw.toLowerCase();

  const aliased = KEY_ALIASES[lower];
  if (aliased && Key[aliased] !== undefined) return Key[aliased];

  // Function keys F1–F24.
  const fn = lower.match(/^f([1-9]|1\d|2[0-4])$/);
  if (fn) {
    const member = `F${fn[1]}`;
    if (Key[member] !== undefined) return Key[member];
  }

  // Single letter a–z.
  if (/^[a-z]$/.test(lower)) {
    const member = lower.toUpperCase();
    if (Key[member] !== undefined) return Key[member];
  }

  // Single digit 0–9 (top-row digits are Num0–Num9 in nut.js).
  if (/^[0-9]$/.test(lower)) {
    const member = `Num${lower}`;
    if (Key[member] !== undefined) return Key[member];
  }

  throw new Error(
    `Unknown key "${raw}". Use a letter (a-z), digit (0-9), a function key (f1-f12), ` +
    `a modifier (cmd, ctrl, alt, shift), or a named key (enter, tab, esc, space, backspace, ` +
    `delete, up, down, left, right, home, end, pageup, pagedown).`,
  );
}
