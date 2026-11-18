/**
 * A key pressed in the agent's browser: the browser tool's `press` action, and
 * the keys a person relays from the phone (relayed-input.ts). The one place a
 * key name becomes input on either backend.
 *
 * Before `press`, the agent had no way to press a key in a page: click, fill
 * and scroll, nothing for WASD, an arrow, Escape or Enter. Checking a keyboard
 * game (the 2026-11-17 parity battery's park-walk), it loaded the browser,
 * looked for another tool that could press keys, then wrote a headless test
 * script of its own, about 45 s of an 86 s run.
 *
 * Key names are the DOM's (`KeyboardEvent.key`, as Playwright reads them): a
 * single character, a named key (Enter, Space, ArrowUp, F5), with modifiers
 * joined by "+" ("Control+a"). The in-app view sends them as Electron input
 * events, which a page receives as trusted keydown/keyup with the real `code`
 * ("KeyW"). A key that makes a character also sends it as a `char` event:
 * without one, a text field gets no character and Enter submits no form
 * (both seen in Electron 2026-11-17).
 *
 * A press is held `holdMs` before it is let go: a page that reads keys once a
 * frame misses a press shorter than a frame, and "walk forward for a second"
 * is a hold.
 */
import type { Page } from "playwright";
import { browserExec, browserInput, type BridgeInputModifier, type BridgeKeyEvent } from "./bridge-client.js";
import { CREDENTIAL_FOCUS_SCRIPT } from "./in-app-page-io.js";
import { PASSWORD_FIELD_REFUSAL } from "./password-field-rule.js";

export const DEFAULT_HOLD_MS = 100;
export const MAX_HOLD_MS = 5_000;

type Modifier = Exclude<BridgeInputModifier, "leftbuttondown">;
const MODIFIERS: Readonly<Record<string, Modifier>> = {
  shift: "shift", control: "control", ctrl: "control", alt: "alt", option: "alt", meta: "meta", cmd: "meta", command: "meta",
};
const PLAYWRIGHT_MODIFIER: Readonly<Record<Modifier, string>> = { shift: "Shift", control: "Control", alt: "Alt", meta: "Meta" };

/** Named keys, by their DOM name, with the name Electron's input events take. */
const NAMED_KEYS: Readonly<Record<string, string>> = {
  Enter: "Enter", Escape: "Escape", Tab: "Tab", Backspace: "Backspace", Delete: "Delete", Space: "Space",
  ArrowUp: "Up", ArrowDown: "Down", ArrowLeft: "Left", ArrowRight: "Right",
  Home: "Home", End: "End", PageUp: "PageUp", PageDown: "PageDown", Insert: "Insert",
  ...Object.fromEntries(Array.from({ length: 12 }, (_, i) => [`F${i + 1}`, `F${i + 1}`])),
};
const KEY_ALIASES: Readonly<Record<string, string>> = {
  esc: "Escape", return: "Enter", del: "Delete", " ": "Space", up: "ArrowUp", down: "ArrowDown", left: "ArrowLeft", right: "ArrowRight",
};

export interface KeyPress {
  /** A single character, or a key of NAMED_KEYS. */
  key: string;
  modifiers: Modifier[];
  holdMs: number;
}

const namedKey = (name: string): string | undefined =>
  Object.keys(NAMED_KEYS).find((k) => k.toLowerCase() === name.toLowerCase()) ?? KEY_ALIASES[name.toLowerCase()];

/** The key the arguments name, checked. Throws a message the model can act on. */
export function parseKeyPress(rawKey: unknown, rawHold?: unknown): KeyPress {
  const text = typeof rawKey === "string" ? rawKey : "";
  const parts = text === "+" || text === " " ? [text] : text.split("+").map((p) => p.trim());
  const last = parts.pop() ?? "";
  const modifiers: Modifier[] = [];
  for (const p of parts) {
    const m = MODIFIERS[p.toLowerCase()];
    if (!m) throw new Error(`"${p}" in "${text}" is not a modifier; use Shift, Control, Alt or Meta, joined with +`);
    if (!modifiers.includes(m)) modifiers.push(m);
  }
  const key = last === " " ? "Space" : last.length === 1 ? last : namedKey(last);
  if (!key) throw new Error(`press needs \`key\`: one character ("w", "1") or a named key (${Object.keys(NAMED_KEYS).slice(0, 14).join(", ")}, F1-F12), with modifiers joined by + ("Control+a")`);
  const hold = rawHold === undefined || rawHold === null ? DEFAULT_HOLD_MS : Number(rawHold);
  if (!Number.isFinite(hold) || hold < 0 || hold > MAX_HOLD_MS) throw new Error(`hold_ms must be between 0 and ${MAX_HOLD_MS}`);
  return { key, modifiers, holdMs: Math.round(hold) };
}

/** The character a press puts into a text field, or null when it puts none. */
function typedChar(press: KeyPress): string | null {
  if (press.modifiers.some((m) => m === "control" || m === "meta" || m === "alt")) return null;
  if (press.key === "Enter") return "\r";
  if (press.key === "Space") return " ";
  return press.key.length === 1 ? press.key : null;
}

/** Whether the press would write into a focused field: a character, or one deleted. */
export function editsText(press: KeyPress): boolean {
  return (typedChar(press) !== null && press.key !== "Enter") || press.key === "Backspace" || press.key === "Delete";
}

/** The bridge events that press the key and those that let it go (in-app view). */
export function bridgeKeyEvents(press: KeyPress): { down: BridgeKeyEvent[]; up: BridgeKeyEvent[] } {
  const keyCode = NAMED_KEYS[press.key] ?? press.key;
  const modifiers = press.modifiers.length > 0 ? { modifiers: [...press.modifiers] } : {};
  const char = typedChar(press);
  return {
    down: [{ type: "keyDown", keyCode, ...modifiers }, ...(char === null ? [] : [{ type: "char" as const, keyCode: char, ...modifiers }])],
    up: [{ type: "keyUp", keyCode, ...modifiers }],
  };
}

export function describeKeyPress(press: KeyPress): string {
  const name = [...press.modifiers.map((m) => PLAYWRIGHT_MODIFIER[m]), press.key].join("+");
  return `Pressed ${name}${press.holdMs > DEFAULT_HOLD_MS ? `, held ${press.holdMs} ms` : ""}.`;
}

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** In the in-app view: Electron input events, as the agent's clicks are. A
 *  key that writes text is refused while a credential field has focus. */
export async function pressKeyInApp(viewId: string, press: KeyPress, opts: { guard?: boolean } = {}): Promise<string> {
  if (opts.guard !== false && editsText(press) && (await browserExec(viewId, CREDENTIAL_FOCUS_SCRIPT)) === true) return PASSWORD_FIELD_REFUSAL;
  const { down, up } = bridgeKeyEvents(press);
  for (const event of down) await browserInput(viewId, event);
  await wait(press.holdMs);
  for (const event of up) await browserInput(viewId, event);
  return describeKeyPress(press);
}

/** In external Chrome: Playwright's keyboard, modifiers held around the key. */
export async function pressKeyCdp(page: Page, press: KeyPress, opts: { guard?: boolean } = {}): Promise<string> {
  if (opts.guard !== false && editsText(press) && (await page.evaluate(CREDENTIAL_FOCUS_SCRIPT)) === true) return PASSWORD_FIELD_REFUSAL;
  const mods = press.modifiers.map((m) => PLAYWRIGHT_MODIFIER[m]);
  for (const m of mods) await page.keyboard.down(m);
  await page.keyboard.down(press.key);
  await wait(press.holdMs);
  await page.keyboard.up(press.key);
  for (const m of mods.reverse()) await page.keyboard.up(m);
  return describeKeyPress(press);
}
