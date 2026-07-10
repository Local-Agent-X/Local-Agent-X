import { describe, expect, it } from "vitest";
import {
  isLoopbackUrl,
  localOnlyRouteDecision,
  localOnlyToolDecision,
  localProviderDecision,
} from "./local-only-policy.js";
import type { LAXConfig } from "./types.js";
import { configSchema } from "./config-schema.js";
import { isProtectedSetting } from "./settings-schema.js";

const strict = { localOnlyMode: true };
const off = { localOnlyMode: false };
const providerConfig = { localOnlyMode: true, ollamaUrl: "http://127.0.0.1:11434" };

describe("strict local-only policy matrix", () => {
  it("has one protected canonical field that defaults off", () => {
    expect(configSchema.parse({}).localOnlyMode).toBe(false);
    expect(isProtectedSetting("localOnlyMode")).toBe(true);
  });
  it.each([
    "http://127.0.0.1:7007/api/health",
    "http://127.1.2.3:9000/app",
    "http://localhost:5173",
    "ws://localhost:7007/ws",
    "http://[::1]:11434/api/tags",
  ])("allows loopback URL %s", (url) => expect(isLoopbackUrl(url)).toBe(true));

  it.each([
    "https://example.com",
    "https://api.openai.com/v1",
    "wss://broker.agentxos.ai",
    "file:///tmp/data",
    "not-a-url",
  ])("rejects non-loopback URL %s", (url) => expect(isLoopbackUrl(url)).toBe(false));

  it.each([
    ["local", undefined, true],
    ["custom", "http://localhost:8080/v1", true],
    ["custom", "https://private-provider.example/v1", false],
    ["openai", undefined, false],
    ["anthropic", undefined, false],
    ["ollama-cloud", undefined, false],
  ])("provider %s is enforced", (provider, baseUrl, allowed) => {
    expect(localProviderDecision(provider as string, providerConfig as Pick<LAXConfig, "localOnlyMode" | "ollamaUrl">, baseUrl as string | undefined).allowed).toBe(allowed);
  });

  it.each([
    ["http_request", { url: "https://example.com" }, false],
    ["http_request", { url: "http://127.0.0.1:7007/api/health" }, true],
    ["web_fetch", { url: "https://example.com" }, false],
    ["web_search", { query: "news" }, false],
    ["browser_navigate", { url: "https://example.com" }, false],
    ["browser_navigate", { url: "http://localhost:5173" }, true],
    ["browser_observe", {}, true],
    ["mcp_github_search", {}, false],
    ["connector_create", {}, false],
    ["generate_image", { prompt: "test" }, false],
    ["bash", { command: "curl https://example.com" }, false],
    ["process_start", { command: "node", args: ["server.js"] }, false],
    ["read", { path: "notes.txt" }, true],
  ])("tool surface %s is enforced", (name, args, allowed) => {
    expect(localOnlyToolDecision(name as string, args as Record<string, unknown>, strict).allowed).toBe(allowed);
  });

  it.each([
    ["POST", "/api/auth/login"],
    ["GET", "/api/auth/status"],
    ["POST", "/api/account/login/start"],
    ["GET", "/api/updates/check"],
    ["POST", "/api/ollama/test-cloud"],
    ["POST", "/api/integrations/test"],
    ["POST", "/api/mcp/servers"],
    ["POST", "/api/sync/push"],
    ["POST", "/api/telegram/connect"],
    ["POST", "/api/whatsapp/connect"],
  ])("blocks direct API bypass %s %s", (method, path) => {
    expect(localOnlyRouteDecision(method, path, strict).allowed).toBe(false);
  });

  it("restores all configured surfaces when the canonical field is off", () => {
    expect(localProviderDecision("openai", { ...providerConfig, localOnlyMode: false }).allowed).toBe(true);
    expect(localOnlyToolDecision("web_search", {}, off).allowed).toBe(true);
    expect(localOnlyRouteDecision("POST", "/api/auth/login", off).allowed).toBe(true);
  });
});
