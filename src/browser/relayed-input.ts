/**
 * A person's input relayed from another screen into the agent's browser: the
 * phone, while a human check is handed to the user
 * (tools/browser-tools/human-check-handoff.ts). Never a model action: the
 * browser tool has no way to send one.
 *
 * A check is not always one tap. A slider is a drag, HUMAN's button is a
 * press held for seconds, a text CAPTCHA wants characters typed. So the phone
 * sends the pointer as it moves (press, move, release: the hold lasts as long
 * as the person's finger does) and typing as text plus the few keys a form
 * needs. Points are fractions (0..1) of the visible page.
 */
import type { Page } from "playwright";
import { browserInput, type BridgeInputEvent } from "./bridge-client.js";
import { clickAtPoint, cssToViewDip, type InAppActionContext } from "./in-app-actions.js";
import { viewportMetricsInApp } from "./in-app-scroll.js";

export const RELAYED_KEYS = ["Backspace", "Enter", "Tab"] as const;
export type RelayedKey = typeof RELAYED_KEYS[number];
export type RelayedPointerKind = "tap" | "press" | "move" | "release";

export type RelayedInput =
  | { kind: RelayedPointerKind; x: number; y: number }
  | { kind: "text"; text: string }
  | { kind: "key"; key: RelayedKey };

const MAX_TEXT = 200;
const POINTER_KINDS: readonly string[] = ["tap", "press", "move", "release"];

/** The request body, checked. Throws with the reason a person can read. */
export function parseRelayedInput(raw: unknown): RelayedInput {
  const body = (raw ?? {}) as Record<string, unknown>;
  const kind = typeof body.kind === "string" ? body.kind : "tap";
  if (POINTER_KINDS.includes(kind)) {
    const x = Number(body.x), y = Number(body.y);
    if (![x, y].every((v) => Number.isFinite(v) && v >= 0 && v <= 1)) throw new Error("x and y must be between 0 and 1");
    return { kind: kind as RelayedPointerKind, x, y };
  }
  if (kind === "text") {
    const text = typeof body.text === "string" ? body.text : "";
    if (!text || text.length > MAX_TEXT || /[\u0000-\u001f\u007f]/.test(text)) throw new Error(`text must be 1 to ${MAX_TEXT} printable characters`);
    return { kind, text };
  }
  if (kind === "key") {
    if (!RELAYED_KEYS.includes(body.key as RelayedKey)) throw new Error(`key must be one of ${RELAYED_KEYS.join(", ")}`);
    return { kind, key: body.key as RelayedKey };
  }
  throw new Error(`unknown input kind "${kind}"`);
}

/** The bridge events for one relayed input, at view-DIP `at` for a pointer. */
export function relayedInputEvents(input: RelayedInput, at: { x: number; y: number } | null): BridgeInputEvent[] {
  switch (input.kind) {
    case "text": return [...input.text].map((ch) => ({ type: "char" as const, keyCode: ch }));
    case "key": return [{ type: "keyDown", keyCode: input.key }, { type: "keyUp", keyCode: input.key }];
    default: break;
  }
  const { x, y } = at!;
  switch (input.kind) {
    case "press": return [{ type: "mouseMove", x, y }, { type: "mouseDown", x, y, button: "left", clickCount: 1 }];
    case "move": return [{ type: "mouseMove", x, y, button: "left", modifiers: ["leftbuttondown"] }];
    case "release": return [{ type: "mouseMove", x, y, button: "left", modifiers: ["leftbuttondown"] }, { type: "mouseUp", x, y, button: "left", clickCount: 1 }];
    default: return [];
  }
}

/** In the in-app view: real input events, as the agent's own clicks are. */
export async function relayInputInApp(ctx: InAppActionContext, input: RelayedInput): Promise<void> {
  if (input.kind === "text" || input.kind === "key") {
    for (const event of relayedInputEvents(input, null)) await browserInput(ctx.viewId, event);
    return;
  }
  const m = await viewportMetricsInApp(ctx);
  const css = { x: input.x * m.vw, y: input.y * m.vh };
  if (input.kind === "tap") { await clickAtPoint(ctx, { ...css, zoom: m.zoom, dpr: m.dpr }); return; }
  const at = cssToViewDip(css.x, css.y, m.zoom, m.dpr);
  for (const event of relayedInputEvents(input, at)) await browserInput(ctx.viewId, event);
}

/** In external Chrome: Playwright's mouse and keyboard. */
export async function relayInputCdp(page: Page, input: RelayedInput): Promise<void> {
  if (input.kind === "text") { await page.keyboard.type(input.text); return; }
  if (input.kind === "key") { await page.keyboard.press(input.key); return; }
  const size = await page.evaluate("({ w: innerWidth, h: innerHeight })") as { w: number; h: number };
  const x = input.x * size.w, y = input.y * size.h;
  switch (input.kind) {
    case "tap": await page.mouse.click(x, y); return;
    case "press": await page.mouse.move(x, y); await page.mouse.down(); return;
    case "move": await page.mouse.move(x, y, { steps: 4 }); return;
    case "release": await page.mouse.move(x, y); await page.mouse.up(); return;
  }
}
