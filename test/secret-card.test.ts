// The secret card (public/js/secret-modal.js), in a real DOM.
// - Save or Cancel is the user's answer to the agent, so it reaches the agent
//   as their message (names only, never a value) and the agent carries on,
//   instead of a client-only receipt the agent never saw.
// - The eye button shows what was typed; every card starts hidden.
// - While the card is open the newest reply gives up its reserved screen of
//   room, or the card is pushed out of sight when a render re-pins the reply.
import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Window } from "happy-dom";

const script = readFileSync(join(process.cwd(), "public", "js", "secret-modal.js"), "utf-8");
const css = readFileSync(join(process.cwd(), "public", "css", "app.css"), "utf-8");
const workspaceCss = readFileSync(join(process.cwd(), "public", "css", "browser-workspace.css"), "utf-8");
const VALUE = "hunter2-correct-horse";

function setup(draft = "") {
  const window = new Window({ url: "http://127.0.0.1" });
  window.document.body.innerHTML = `<div id="messages"><div class="msg assistant pin-bottom">Enter your login</div></div><textarea id="msg-input"></textarea>`;
  const input = window.document.getElementById("msg-input") as unknown as { value: string };
  input.value = draft;
  const sent: string[] = [];
  const runtime = window as unknown as Record<string, unknown>;
  runtime.apiPost = vi.fn(async () => ({ ok: true }));
  runtime.sendMessage = vi.fn(async () => { sent.push(input.value); input.value = ""; });
  window.eval(script);
  window.eval(`showMultiSecretModal([
    { name: "TWILIO_LOGIN_EMAIL", service: "Twilio", reason: "Sign-in email", url: "https://www.twilio.com/login" },
    { name: "TWILIO_LOGIN_PASSWORD", service: "Twilio", reason: "Sign-in password", url: "https://www.twilio.com/login" },
  ])`);
  const doc = window.document;
  const fields = [...doc.querySelectorAll(".secret-input-field")] as unknown as Array<{ value: string; type: string }>;
  return { window, doc, input, sent, fields, apiPost: runtime.apiPost as ReturnType<typeof vi.fn> };
}

describe("the secret card", () => {
  it("Save tells the agent which names were saved, never a value, and keeps the user's draft", async () => {
    const { window, sent, fields, input, apiPost } = setup("half-typed question");
    fields[0].value = "me@example.com";
    fields[1].value = VALUE;
    await window.eval("submitSecret()");
    expect(apiPost).toHaveBeenCalledTimes(2);
    expect(sent).toEqual(["I saved TWILIO_LOGIN_EMAIL and TWILIO_LOGIN_PASSWORD in the secrets vault. Go ahead."]);
    expect(sent.join(" ")).not.toContain(VALUE);
    expect(input.value).toBe("half-typed question");
  });

  it("Cancel tells the agent it was cancelled", async () => {
    const { window, sent } = setup();
    await window.eval("cancelSecret()");
    await new Promise((r) => setTimeout(r, 0));
    expect(sent).toEqual(["I cancelled the request for TWILIO_LOGIN_EMAIL and TWILIO_LOGIN_PASSWORD; I didn't save them."]);
  });

  it("a value that didn't save is reported as not saved", async () => {
    const { window, sent, fields, apiPost } = setup();
    apiPost.mockResolvedValueOnce({ ok: true }).mockResolvedValueOnce({ ok: false, error: "vault locked" });
    fields[0].value = "me@example.com";
    fields[1].value = VALUE;
    await window.eval("submitSecret()");
    expect(sent[0]).toMatch(/^I saved TWILIO_LOGIN_EMAIL in the secrets vault\. TWILIO_LOGIN_PASSWORD \(vault locked\) didn't save\./);
  });

  it("the eye button shows and hides what was typed; a card starts hidden", () => {
    const { doc, fields } = setup();
    const eye = doc.querySelectorAll(".secret-reveal")[1] as unknown as { click(): void; getAttribute(n: string): string };
    expect(fields[1].type).toBe("password");
    eye.click();
    expect(fields[1].type).toBe("text");
    expect(eye.getAttribute("aria-pressed")).toBe("true");
    eye.click();
    expect(fields[1].type).toBe("password");
    expect(fields[0].type).toBe("password");
  });

  it("an open card cancels the reply's reserved room, and stays visible in the browser workspace's latest-turn view", () => {
    const { doc } = setup();
    expect(doc.querySelector("#messages > #secret-modal-overlay.visible")).not.toBeNull();
    expect(css).toMatch(/#messages:has\(> #secret-modal-overlay\.visible\) \.msg\.assistant\.pin-bottom\{\s*min-height:0;/);
    expect(workspaceCss).toContain("#messages > #secret-modal-overlay.visible{display:block!important}");
  });
});
