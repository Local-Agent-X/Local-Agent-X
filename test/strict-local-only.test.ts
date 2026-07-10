/**
 * strictLocalOnly — the hard local-only mode (config.json flag, default off).
 *
 * Enforcement seams pinned here:
 *  1. egress-policy.ts    — isStrictLocalOnly / getEffectiveEgressMode /
 *                           checkEgress behave as loopback+RFC1918+ollama-only
 *                           allowlist while the flag is on.
 *  2. network-policy.ts   — evaluateWebFetch (THE choke point for web_fetch /
 *                           http_request / browser navigation / redirect and
 *                           integration re-checks) denies public hosts while
 *                           keeping self-calls and the ollama loopback
 *                           carve-out reachable.
 *  3. auth/resolve.ts     — resolveCredential throws a flag-naming error for
 *                           cloud providers; the local Ollama sentinel still
 *                           resolves.
 *  4. routes/bridges/auth — cloud sign-in initiation routes refuse (403 body)
 *                           while status/logout/cancel stay reachable.
 *
 * Flag OFF must be a zero-behavior change — asserted for every seam.
 *
 * All modules read the flag at CALL time from <LAX_DATA_DIR>/config.json, so
 * each test gets a fresh temp data dir (vi.resetModules + dynamic import, the
 * same pattern as canonical-loop-cost-recording.test.ts).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Light-weight registry stub so resolveCredential tests don't drag transports
// in. Only `auth.resolve` is consumed by the module under test.
vi.mock("../src/providers/registry.js", () => ({
  PROVIDERS: {
    anthropic: { auth: { resolve: async () => ({ provider: "anthropic", credential: "sk-test", source: "env" }) } },
    xai: { auth: { resolve: async () => ({ provider: "xai", credential: "xai-test", source: "env" }) } },
    local: { auth: { resolve: async () => ({ provider: "local", credential: "ollama", source: "sentinel" }) } },
  },
}));
vi.mock("../src/secrets.js", () => ({
  getSecretsStoreSingleton: () => null,
}));

let tmp: string;
let prevDataDir: string | undefined;

beforeEach(() => {
  vi.resetModules();
  prevDataDir = process.env.LAX_DATA_DIR;
  tmp = mkdtempSync(join(tmpdir(), "lax-strict-local-"));
  process.env.LAX_DATA_DIR = tmp;
});

afterEach(() => {
  if (prevDataDir === undefined) delete process.env.LAX_DATA_DIR;
  else process.env.LAX_DATA_DIR = prevDataDir;
  rmSync(tmp, { recursive: true, force: true });
});

function writeConfig(cfg: Record<string, unknown>): void {
  writeFileSync(join(tmp, "config.json"), JSON.stringify(cfg), "utf-8");
}

describe("egress-policy — isStrictLocalOnly / getEffectiveEgressMode / checkEgress", () => {
  it("flag defaults OFF: no config file, missing key, or explicit false", async () => {
    const mod = await import("../src/security/egress-policy.js");
    expect(mod.isStrictLocalOnly()).toBe(false); // no config.json at all
    writeConfig({});
    expect(mod.isStrictLocalOnly()).toBe(false);
    writeConfig({ strictLocalOnly: false });
    expect(mod.isStrictLocalOnly()).toBe(false);
    expect(mod.getEffectiveEgressMode()).toBe("permissive");
  });

  it("flag OFF: checkEgress is unchanged (permissive allows public hosts)", async () => {
    writeConfig({ strictLocalOnly: false });
    const { checkEgress } = await import("../src/security/egress-policy.js");
    expect(checkEgress("api.example.com").allowed).toBe(true);
  });

  it("flag ON: effective mode is allowlist; public hosts refused with a flag-naming reason", async () => {
    writeConfig({ strictLocalOnly: true });
    const mod = await import("../src/security/egress-policy.js");
    expect(mod.isStrictLocalOnly()).toBe(true);
    expect(mod.getEffectiveEgressMode()).toBe("allowlist");
    const denied = mod.checkEgress("api.example.com");
    expect(denied.allowed).toBe(false);
    expect(denied.reason).toContain("strictLocalOnly");
  });

  it("flag ON: loopback + RFC1918 + the configured ollama host stay allowed", async () => {
    writeConfig({ strictLocalOnly: true, ollamaUrl: "http://127.0.0.1:11434" });
    const { checkEgress } = await import("../src/security/egress-policy.js");
    expect(checkEgress("127.0.0.1").allowed).toBe(true);
    expect(checkEgress("localhost").allowed).toBe(true);
    expect(checkEgress("192.168.1.10").allowed).toBe(true);
    expect(checkEgress("10.0.0.5").allowed).toBe(true);
    expect(checkEgress("172.16.4.2").allowed).toBe(true);
    // NOT local-allowed: cloud metadata link-local and public ranges
    expect(checkEgress("169.254.169.254").allowed).toBe(false);
    expect(checkEgress("8.8.8.8").allowed).toBe(false);
  });

  it("flag ON: a public ollamaUrl does NOT open public egress (config-injection hardening)", async () => {
    writeConfig({ strictLocalOnly: true, ollamaUrl: "http://attacker.com:11434" });
    const { checkEgress } = await import("../src/security/egress-policy.js");
    expect(checkEgress("attacker.com").allowed).toBe(false);
    // ... and loopback still works regardless of the poisoned ollamaUrl
    expect(checkEgress("127.0.0.1").allowed).toBe(true);
  });

  it("flag ON: a per-domain allow RULE does not override local-only", async () => {
    writeConfig({ strictLocalOnly: true });
    const mod = await import("../src/security/egress-policy.js");
    mod.addEgressRule("api.example.com", "allow");
    expect(mod.checkEgress("api.example.com").allowed).toBe(false);
  });
});

describe("network-policy — evaluateWebFetch choke point", () => {
  const empty = new Set<string>();

  it("flag OFF: public hosts pass in permissive mode (zero behavior change)", async () => {
    writeConfig({ strictLocalOnly: false });
    const { evaluateWebFetch } = await import("../src/security/network-policy.js");
    expect(evaluateWebFetch(empty, false, "7007", "https://api.example.com/v1", "permissive", empty).allowed).toBe(true);
  });

  it("flag ON: public hosts are blocked with a flag-naming reason", async () => {
    writeConfig({ strictLocalOnly: true });
    const { evaluateWebFetch } = await import("../src/security/network-policy.js");
    const d = evaluateWebFetch(empty, false, "7007", "https://api.example.com/v1", "permissive", empty);
    expect(d.allowed).toBe(false);
    expect(d.reason).toContain("strictLocalOnly");
  });

  it("flag ON: an on-disk egress allowlist canNOT re-open a public host", async () => {
    writeConfig({ strictLocalOnly: true });
    const { evaluateWebFetch } = await import("../src/security/network-policy.js");
    const allow = new Set(["api.example.com"]);
    expect(evaluateWebFetch(allow, true, "7007", "https://api.example.com/v1", "strict", empty).allowed).toBe(false);
  });

  it("flag ON: self-call and the ollama loopback carve-out stay allowed", async () => {
    writeConfig({ strictLocalOnly: true, ollamaUrl: "http://127.0.0.1:11434" });
    const { evaluateWebFetch, evaluateEgressForUrl } = await import("../src/security/network-policy.js");
    // Self-call to own server
    expect(evaluateWebFetch(empty, false, "7007", "http://127.0.0.1:7007/api/health", "permissive", empty).allowed).toBe(true);
    // Ollama via explicit localServicePorts (pre-dispatch gate shape)
    expect(evaluateWebFetch(empty, false, "7007", "http://127.0.0.1:11434/api/embed", "permissive", new Set(["11434"])).allowed).toBe(true);
    // Ollama via the on-disk loader path (redirect/browser-request-layer shape:
    // loadEgressConfig folds ollamaLoopbackPort into localServicePorts)
    expect(evaluateEgressForUrl("http://127.0.0.1:11434/api/embed").allowed).toBe(true);
    // ... while a public host through the same loader path is blocked
    const pub = evaluateEgressForUrl("https://api.example.com/v1");
    expect(pub.allowed).toBe(false);
    expect(pub.reason).toContain("strictLocalOnly");
  });

  it("flag ON: SSRF blocks are not weakened (metadata + random loopback port stay blocked)", async () => {
    writeConfig({ strictLocalOnly: true });
    const { evaluateWebFetch } = await import("../src/security/network-policy.js");
    expect(evaluateWebFetch(empty, false, "7007", "http://169.254.169.254/latest/meta-data", "permissive", empty).allowed).toBe(false);
    expect(evaluateWebFetch(empty, false, "7007", "http://127.0.0.1:6379/", "permissive", empty).allowed).toBe(false);
  });
});

describe("auth/resolve — cloud credential seam", () => {
  it("flag OFF: cloud and local providers resolve unchanged", async () => {
    writeConfig({ strictLocalOnly: false });
    const { resolveCredential } = await import("../src/auth/resolve.js");
    expect((await resolveCredential("anthropic"))?.credential).toBe("sk-test");
    expect((await resolveCredential("local"))?.source).toBe("sentinel");
  });

  it("flag ON: cloud providers throw an error naming the flag", async () => {
    writeConfig({ strictLocalOnly: true });
    const { resolveCredential } = await import("../src/auth/resolve.js");
    await expect(resolveCredential("anthropic")).rejects.toThrow(/strictLocalOnly/);
    await expect(resolveCredential("xai")).rejects.toThrow(/strictLocalOnly/);
  });

  it("flag ON: the local Ollama provider keeps resolving its sentinel", async () => {
    writeConfig({ strictLocalOnly: true });
    const { resolveCredential } = await import("../src/auth/resolve.js");
    const r = await resolveCredential("local");
    expect(r?.credential).toBe("ollama");
    expect(r?.source).toBe("sentinel");
  });
});

describe("web_search / image_search — tool-seam refusal", () => {
  // These tools fetch search-provider APIs directly (never through
  // evaluateWebFetch), so they carry their own seam check.
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("flag ON: web_search refuses with an error naming the flag, without fetching", async () => {
    writeConfig({ strictLocalOnly: true });
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const { webSearchTool } = await import("../src/tools/web-search-tool.js");
    const r = await webSearchTool.execute({ query: "anything" });
    expect(r.isError).toBe(true);
    expect(r.content).toContain("strictLocalOnly");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("flag ON: image_search refuses with an error naming the flag, without fetching", async () => {
    writeConfig({ strictLocalOnly: true });
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const { imageSearchTool } = await import("../src/tools/image-search-tool.js");
    const r = await imageSearchTool.execute({ query: "anything" });
    expect(r.isError).toBe(true);
    expect(r.content).toContain("strictLocalOnly");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("flag OFF: both tools run their provider fetch path unchanged", async () => {
    writeConfig({ strictLocalOnly: false });
    // Empty-result provider responses: proves the fetch path executed and the
    // tools completed their normal (no-results) flow, with zero refusals.
    const fetchSpy = vi.fn(async () =>
      new Response("<html></html>", { status: 200, headers: { "Content-Type": "text/html" } }));
    vi.stubGlobal("fetch", fetchSpy);
    const { webSearchTool } = await import("../src/tools/web-search-tool.js");
    const ws = await webSearchTool.execute({ query: "anything" });
    expect(String(ws.content)).not.toContain("strictLocalOnly");
    expect(fetchSpy).toHaveBeenCalled();

    const jsonSpy = vi.fn(async () =>
      new Response("{}", { status: 200, headers: { "Content-Type": "application/json" } }));
    vi.stubGlobal("fetch", jsonSpy);
    const { imageSearchTool } = await import("../src/tools/image-search-tool.js");
    const is = await imageSearchTool.execute({ query: "anything" });
    expect(String(is.content)).not.toContain("strictLocalOnly");
    expect(jsonSpy).toHaveBeenCalled();
  });
});

describe("routes/bridges/auth — cloud sign-in refusal", () => {
  const LOGIN_PATHS = [
    "/api/auth/login",
    "/api/auth/openai/cli-login",
    "/api/auth/anthropic/setup-token",
    "/api/auth/anthropic/cli-login",
    "/api/auth/anthropic/cli-login-submit",
    "/api/auth/xai/login",
    "/api/auth/xai/exchange-code",
    "/api/auth/xai/cli-login",
  ];

  it("flag OFF: no login route is refused (zero behavior change)", async () => {
    writeConfig({ strictLocalOnly: false });
    const { strictLocalOnlyLoginRefusal } = await import("../src/routes/bridges/auth/index.js");
    for (const p of LOGIN_PATHS) expect(strictLocalOnlyLoginRefusal("POST", p)).toBeNull();
  });

  it("flag ON: every cloud sign-in initiation refuses with a flag-naming message", async () => {
    writeConfig({ strictLocalOnly: true });
    const { strictLocalOnlyLoginRefusal } = await import("../src/routes/bridges/auth/index.js");
    for (const p of LOGIN_PATHS) {
      const msg = strictLocalOnlyLoginRefusal("POST", p);
      expect(msg, p).toContain("strictLocalOnly");
    }
  });

  it("flag ON: status / logout / cancel routes are NOT refused", async () => {
    writeConfig({ strictLocalOnly: true });
    const { strictLocalOnlyLoginRefusal } = await import("../src/routes/bridges/auth/index.js");
    expect(strictLocalOnlyLoginRefusal("GET", "/api/auth/status")).toBeNull();
    expect(strictLocalOnlyLoginRefusal("GET", "/api/auth/anthropic/status")).toBeNull();
    expect(strictLocalOnlyLoginRefusal("POST", "/api/auth/logout")).toBeNull();
    expect(strictLocalOnlyLoginRefusal("POST", "/api/auth/anthropic/cli-login-cancel")).toBeNull();
    expect(strictLocalOnlyLoginRefusal("POST", "/api/auth/xai/cli-login-cancel")).toBeNull();
  });
});
