// @vitest-environment happy-dom
//
// The composer's model picker changes the chat on screen, not every chat
// (ADR 0007 §8): with a chat open it posts /api/providers/session-model and
// reads /api/providers?session=<that chat>; with none it still sets the
// default. Opening another chat refetches the list for that chat.
import { describe, it, expect, beforeEach, vi } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(join(here, "../public/js/chat-model-pin.js"), "utf8")
  + "\n" + readFileSync(join(here, "../public/js/chat-status-bar.js"), "utf8");

type Bar = {
  laxSwitchModel: (provider: string, model: string, effort?: string) => Promise<void>;
  loadProviders: () => Promise<unknown>;
  laxGetSavedEffort: () => string;
  laxOnSessionModelChanged: (change: { sessionId: string }) => void;
};

const calls: Array<{ url: string; body?: unknown }> = [];
let providersBody: Record<string, unknown> = {};
const apiFetch = vi.fn(async (url: string, init?: { body?: string }) => {
  calls.push({ url, body: init?.body ? JSON.parse(init.body) : undefined });
  return { ok: true, json: async () => (url.startsWith("/api/providers?") || url === "/api/providers" ? providersBody : {}) };
});

function load(): Bar {
  return new Function(
    "esc", "laxResolveActiveProvider", "laxProviderLabel", "isProvidersComplete", "apiFetch",
    `${source}\nreturn { laxSwitchModel, loadProviders, laxGetSavedEffort, laxOnSessionModelChanged };`,
  )((s: unknown) => String(s), () => null, (id: string) => id, () => true, apiFetch);
}

let bar: Bar;
beforeEach(() => {
  document.body.innerHTML = `<span id="composer-chips"></span><span id="status-bar-dynamic"></span>`;
  calls.length = 0;
  providersBody = { providers: [], current: { provider: "xai", model: "grok-4.3", effort: "high", pinned: true } };
  (window as { activeChat?: unknown }).activeChat = { id: "chat-a" };
  bar = load();
});

describe("the model picker follows the chat on screen", () => {
  it("sets the open chat's model, never the default", async () => {
    await bar.laxSwitchModel("xai", "grok-4.3", "high");
    expect(calls[0]).toEqual({ url: "/api/providers/session-model", body: { sessionId: "chat-a", provider: "xai", model: "grok-4.3", effort: "high" } });
    expect(calls.some(c => c.url === "/api/providers/switch" || c.url === "/api/settings")).toBe(false);
    expect(calls.at(-1)?.url).toBe("/api/providers?session=chat-a");
  });

  it("sets the default when no chat is open", async () => {
    (window as { activeChat?: unknown }).activeChat = null;
    await bar.laxSwitchModel("anthropic", "claude-opus-5-5");
    expect(calls[0]).toMatchObject({ url: "/api/providers/switch", body: { provider: "anthropic", model: "claude-opus-5-5" } });
  });

  it("refetches the list for another chat and shows that chat's effort", async () => {
    await bar.loadProviders();
    expect(bar.laxGetSavedEffort()).toBe("high");
    (window as { activeChat?: unknown }).activeChat = { id: "chat-b" };
    providersBody = { providers: [], current: { provider: "anthropic", model: "claude-opus-5-5", effort: "low", pinned: false } };
    await bar.loadProviders();
    expect(calls.at(-1)?.url).toBe("/api/providers?session=chat-b");
    expect(bar.laxGetSavedEffort()).toBe("low");
  });

  it("redraws only when the change is for the chat on screen", async () => {
    await bar.loadProviders();
    const before = calls.length;
    bar.laxOnSessionModelChanged({ sessionId: "chat-other" });
    expect(calls.length).toBe(before);
    bar.laxOnSessionModelChanged({ sessionId: "chat-a" });
    await Promise.resolve();
    expect(calls.at(-1)?.url).toBe("/api/providers?session=chat-a");
  });
});
