// Website passwords live in the vault and reach a page only through
// browser_fill_from_secret, which fills a secret only on the site it was saved
// for. request_secret had no way to record that site, so a password saved
// through it could never be filled anywhere (2026-10-03).
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SecretsStore } from "../secrets.js";
import { createSecretTools } from "./secret-tools.js";
import type { ServerEvent } from "../types.js";

let dir = "";
let store: SecretsStore;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "lax-secret-tools-"));
  store = new SecretsStore(dir);
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function tool(name: string, events: ServerEvent[]) {
  return createSecretTools(store, (e) => events.push(e)).find((t) => t.name === name)!;
}

describe("a website login through the vault", () => {
  it("request_secret carries the login page to the prompt and says how the password will be used", async () => {
    const events: ServerEvent[] = [];
    const res = await tool("request_secret", events).execute({ name: "TWILIO_PASSWORD", service: "Twilio", reason: "Sign in to the console", url: "https://www.twilio.com/login" });
    expect(events).toEqual([{ type: "secret_request", name: "TWILIO_PASSWORD", service: "Twilio", reason: "Sign in to the console", url: "https://www.twilio.com/login" }]);
    expect(res.content).toContain("browser_fill_from_secret");
  });

  it("request_secrets carries each entry's login page", async () => {
    const events: ServerEvent[] = [];
    await tool("request_secrets", events).execute({ secrets: [
      { name: "TWILIO_USERNAME", reason: "Sign in", url: "https://www.twilio.com/login" },
      { name: "TWILIO_PASSWORD", reason: "Sign in", url: "https://www.twilio.com/login" },
    ] });
    expect(events[0]).toMatchObject({ type: "secrets_request", secrets: [{ url: "https://www.twilio.com/login" }, { url: "https://www.twilio.com/login" }] });
  });

  it("list_secrets shows a saved login's site and points to the vault fill, and an API key to a placeholder", async () => {
    store.set("TWILIO_PASSWORD", "pw-value", { url: "https://www.twilio.com/login" });
    store.set("OPENWEATHER_KEY", "key-value");
    const res = await tool("list_secrets", []).execute({});
    expect(res.content).toMatch(/TWILIO_PASSWORD — website login for https:\/\/www\.twilio\.com: fill it with browser_fill_from_secret/);
    expect(res.content).toContain("OPENWEATHER_KEY — use as {{OPENWEATHER_KEY}} in http_request headers");
    expect(res.content).not.toContain("pw-value");
  });
});
