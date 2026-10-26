// @vitest-environment happy-dom
/**
 * The slash popup selects the row it shows highlighted. It grouped rows by
 * category only when drawing them, so `/sen` drew /senior-engineer
 * (Developer) highlighted on top while Enter picked the API's first match,
 * /send_email (2026-10-26).
 */
import { describe, it, expect, beforeAll } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));

// The API's own order: typed packs first, the developer skills after.
const PROTOCOLS = [
  { name: "send_email", description: "Send an email", category: "" },
  { name: "send_slack", description: "Post to Slack", category: "" },
  { name: "senior-engineer", description: "Senior-engineer discipline", category: "Developer" },
];

let input: HTMLTextAreaElement;

beforeAll(async () => {
  document.body.innerHTML = '<textarea id="msg-input"></textarea>';
  (window as unknown as { apiFetch: () => Promise<unknown> }).apiFetch = async () => ({
    ok: true,
    json: async () => ({ protocols: PROTOCOLS }),
  });
  // eslint-disable-next-line no-new-func
  new Function(readFileSync(join(here, "../public/js/chat-slash-popup.js"), "utf8"))();
  await new Promise((r) => setTimeout(r, 0));
  input = document.getElementById("msg-input") as HTMLTextAreaElement;
});

function type(text: string): void {
  input.value = text;
  input.setSelectionRange(text.length, text.length);
  input.dispatchEvent(new Event("input"));
}

function press(key: string): void {
  input.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }));
}

const shownRows = () => [...document.querySelectorAll(".slash-popup-item .slash-popup-name")].map((el) => el.textContent);
const highlighted = () => document.querySelector(".slash-popup-item.active .slash-popup-name")?.textContent;

describe("the slash popup", () => {
  it("Enter inserts the row shown highlighted", () => {
    type("/sen");
    expect(shownRows()[0]).toBe("/senior-engineer");
    expect(highlighted()).toBe("/senior-engineer");
    press("Enter");
    expect(input.value).toBe("/senior-engineer ");
  });

  it("arrowing down moves to the next SHOWN row, and Enter inserts that one", () => {
    type("fix this /sen");
    press("ArrowDown");
    const second = shownRows()[1];
    expect(highlighted()).toBe(second);
    press("Enter");
    expect(input.value).toBe(`fix this ${second} `);
  });
});
