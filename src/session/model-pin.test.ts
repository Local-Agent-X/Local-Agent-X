import { describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createModelPinStore, isPinnableSessionId, parseModelPin, pinnedRequestOverrides } from "./model-pin.js";

const tempStore = () => {
  const file = join(mkdtempSync(join(tmpdir(), "lax-pin-")), "pins.json");
  return { file, store: createModelPinStore(file) };
};

describe("a chat's model pin", () => {
  it("is kept per chat and survives a new store over the same file", () => {
    const { file, store } = tempStore();
    store.set("chat-a", { provider: "xai", model: "grok-4.3", effort: "high" });
    store.set("chat-b", { provider: "anthropic", model: "" });

    const reopened = createModelPinStore(file);
    expect(reopened.get("chat-a")).toMatchObject({ provider: "xai", model: "grok-4.3", effort: "high" });
    expect(reopened.get("chat-b")).toMatchObject({ provider: "anthropic", model: "" });
    expect(reopened.get("chat-c")).toBeNull();
    expect(JSON.parse(readFileSync(file, "utf8")).pins["chat-a"].setAt).toMatch(/^\d{4}-/);
  });

  it("clear puts a chat back on the default and says whether it had one", () => {
    const { store } = tempStore();
    store.set("chat-a", { provider: "xai", model: "" });
    expect(store.clear("chat-a")).toBe(true);
    expect(store.get("chat-a")).toBeNull();
    expect(store.clear("chat-a")).toBe(false);
  });

  it("accepts the ids chats, IDE sessions and bridges use, and nothing path-shaped", () => {
    for (const id of ["chat-mh3k2x9", "ide-calendar", "telegram:12345", "voice_abc.1"]) expect(isPinnableSessionId(id)).toBe(true);
    for (const id of ["", "../x", "a/b", "a\\b", "x".repeat(201), 42]) expect(isPinnableSessionId(id)).toBe(false);
    const { store } = tempStore();
    expect(() => store.set("../x", { provider: "xai", model: "" })).toThrow();
    expect(store.get("../x")).toBeNull();
  });

  it("parses a picker's request and names what is wrong", () => {
    expect(parseModelPin({ provider: "codex", model: " gpt-5.5 ", effort: "xhigh" })).toEqual({ pin: { provider: "codex", model: "gpt-5.5", effort: "xhigh" } });
    expect(parseModelPin({ provider: "codex" })).toEqual({ pin: { provider: "codex", model: "" } });
    expect(parseModelPin({ provider: "skynet" })).toHaveProperty("error");
    expect(parseModelPin({ provider: "codex", effort: "turbo" })).toHaveProperty("error");
    expect(parseModelPin({ provider: "codex", model: "m".repeat(201) })).toHaveProperty("error");
  });
});

describe("every turn a user runs in a chat uses its pin", () => {
  it("turns a pin into the request overrides, and no pin into none", () => {
    const { store } = tempStore();
    store.set("chat-a", { provider: "xai", model: "grok-4.6", effort: "low" });
    store.set("chat-b", { provider: "anthropic", model: "" });
    expect(pinnedRequestOverrides("chat-a", store)).toEqual({ providerOverride: "xai", modelOverride: "grok-4.6", reasoningEffortOverride: "low" });
    expect(pinnedRequestOverrides("chat-b", store)).toEqual({ providerOverride: "anthropic" });
    expect(pinnedRequestOverrides("chat-none", store)).toEqual({});
  });

  // 2026-11-15: a voice call prepared its turn without the pin, so a chat
  // switched to grok-4.6 at low effort kept speaking through grok-4.7 at medium.
  it("is applied by the typed turn and the spoken turn alike", () => {
    const src = (rel: string) => readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", rel), "utf8");
    for (const file of ["routes/chat/run-chat-turn/prepare-and-route.ts", "server/voice-ws.ts"]) {
      expect(src(file), file).toMatch(/prepareAgentRequest\(\{[^}]*\.\.\.pinnedRequestOverrides\(sessionId\)/s);
    }
  });
});
