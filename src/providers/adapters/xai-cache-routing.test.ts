import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { XAI_CONVERSATION_HEADER, cacheRoutingHeaders } from "./xai-cache-routing.js";

describe("xAI cache routing header", () => {
  it("routes one session's xAI requests by a stable hash, never the raw id", () => {
    const a = cacheRoutingHeaders("https://api.x.ai/v1", "chat-mwihw7qa-p4nn2");
    const again = cacheRoutingHeaders("https://api.x.ai/v1", "chat-mwihw7qa-p4nn2");
    const other = cacheRoutingHeaders("https://api.x.ai/v1", "chat-other");
    expect(a[XAI_CONVERSATION_HEADER]).toMatch(/^[0-9a-f]{32}$/);
    expect(again).toEqual(a);
    expect(other[XAI_CONVERSATION_HEADER]).not.toBe(a[XAI_CONVERSATION_HEADER]);
    expect(JSON.stringify(a)).not.toContain("mwihw7qa");
  });

  it("sends nothing to any other endpoint, or without a session", () => {
    expect(cacheRoutingHeaders("http://127.0.0.1:11434/v1", "chat-a")).toEqual({});
    expect(cacheRoutingHeaders("https://api.x.ai.example.com/v1", "chat-a")).toEqual({});
    expect(cacheRoutingHeaders("https://generativelanguage.googleapis.com/v1beta/openai", "chat-a")).toEqual({});
    expect(cacheRoutingHeaders("https://api.x.ai/v1", undefined)).toEqual({});
    expect(cacheRoutingHeaders(undefined, "chat-a")).toEqual({});
  });

  it("is on every request the OpenAI-compatible client makes", () => {
    const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "openai-http.ts"), "utf8");
    expect(src).toMatch(/new OpenAI\(\{[^}]*defaultHeaders: cacheRoutingHeaders\(req\.baseURL, req\.sessionId\)/);
  });
});
