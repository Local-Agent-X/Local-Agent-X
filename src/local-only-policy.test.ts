import { describe, expect, it } from "vitest";
import {
  isLoopbackUrl,
  localOnlyRouteDecision,
  localOnlyToolDecision,
  localProviderDecision,
} from "./local-only-policy.js";
import type { LAXConfig } from "./types.js";
import { CAPABILITY_CLASS_MEMBERS, TOOLS, hasCapability, toolsWhere } from "./tool-registry.js";
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

  // Each decision is read off the tool's policy row: a URL-addressed tool by
  // where the call points, any other by its kernel class, shell capability,
  // risk tier, destination or, where none of those says it, its `reach`.
  it.each([
    ["http_request", { url: "https://example.com" }, false],
    ["http_request", { url: "http://127.0.0.1:7007/api/health" }, true],
    ["http_request", {}, false],
    ["web_fetch", { url: "https://example.com" }, false],
    ["ari_http", { url: "http://localhost:7007/api/health" }, true],
    ["web_search", { query: "news" }, false],
    ["image_search", { query: "cats" }, false],
    ["compare_pages", { a: "https://example.com", b: "https://example.org" }, false],
    ["extract_site_assets", { url: "https://example.com", output_dir: "assets" }, false],
    ["extract_site_assets", { url: "http://localhost:5173", output_dir: "assets" }, true],
    ["youtube_analyze", { url: "http://localhost:5173/clip" }, false],
    ["browser", { action: "navigate", url: "https://example.com" }, false],
    ["browser", { action: "navigate", url: "http://localhost:5173" }, true],
    ["browser", { action: "observe" }, true],
    ["mcp_github_search", {}, false],
    ["connector_create", { upstream: "http://localhost:8000" }, false],
    ["generate_image", { prompt: "test" }, false],
    ["edit_image", { image: "a.png", prompt: "test" }, false],
    ["build_app", { name: "demo" }, false],
    ["start_app_build", { name: "demo" }, false],
    ["apply_update", {}, false],
    ["check_for_updates", {}, false],
    ["marketplace_search", { query: "notes" }, false],
    ["marketplace_install", { name: "notes" }, false],
    ["email_read", { folder: "INBOX" }, false],
    ["email_search", { query: "invoice" }, false],
    ["email_draft", { to: "a@example.com" }, false],
    ["email_delete", { folder: "INBOX", uid: 1 }, false],
    ["email_setup", {}, false],
    ["email_send", { to: "a@example.com" }, false],
    ["telegram_send", { chat_id: "1", text: "hi" }, false],
    ["send_file", { path: "report.pdf" }, false],
    ["bash", { command: "curl https://example.com" }, false],
    ["process_start", { command: "node", args: ["server.js"] }, false],
    ["app_rebuild", {}, false],
    ["android", { action: "tap", x: 1, y: 1 }, true],
    ["android", { action: "open_url", url: "https://example.com" }, false],
    ["computer", { action: "screen_size" }, true],
    ["clipboard_write", { text: "x" }, true],
    ["view_image", { path: "a.png" }, true],
    ["transcribe_media", { path: "a.wav" }, true],
    ["calendar_list_events", {}, true],
    ["calendar_create_event", { title: "Sync" }, true],
    ["sql_query", { database: "a.db", sql: "select 1" }, true],
    ["memory_search", { query: "x" }, true],
    ["read", { path: "notes.txt" }, true],
  ])("tool surface %s is enforced", (name, args, allowed) => {
    expect(localOnlyToolDecision(name as string, args as Record<string, unknown>, strict).allowed).toBe(allowed);
  });

  it("every tool whose row reaches a network service is blocked when pointed off-box, and nothing that only touches this box", () => {
    const decided = (name: string) => localOnlyToolDecision(name, { url: "https://example.com" }, strict).allowed;
    for (const [name, entry] of Object.entries(TOOLS)) {
      if (entry.kernel === "http" || entry.risk === "network-read" || entry.risk === "network-write" || entry.risk === "external-comms") {
        expect(decided(name), `${name} reaches a network service`).toBe(false);
      }
    }
    for (const name of CAPABILITY_CLASS_MEMBERS.shell) expect(decided(name), `${name} runs a subprocess`).toBe(name === "android");
    for (const name of ["read", "write", "edit", "glob", "memory_save", "task_create", "spreadsheet", "document", "sql_schema", "agent_status"]) {
      expect(decided(name), name).toBe(true);
    }
  });

  // `reach` is the fact a row states only when no other fact says where the
  // tool goes. Each kind must change the decision, or it is a dead declaration.
  it("an indirect-network tool is blocked even pointed at loopback, and a local-device tool is a shell tool let through", () => {
    const indirect = toolsWhere((row) => row.reach?.kind === "indirect-network");
    expect(indirect).toEqual(expect.arrayContaining(["build_app", "apply_update", "connector_create", "youtube_analyze"]));
    for (const name of indirect) expect(localOnlyToolDecision(name, { url: "http://127.0.0.1:5173" }, strict).allowed, name).toBe(false);
    const device = toolsWhere((row) => row.reach?.kind === "local-device");
    expect(device).toEqual(["android"]);
    for (const name of device) expect(hasCapability(name, "shell"), `${name}: local-device only means something on a shell tool`).toBe(true);
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
