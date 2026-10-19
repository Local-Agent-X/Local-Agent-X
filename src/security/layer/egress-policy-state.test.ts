import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { EgressPolicyState, normalizeEgressHost, SEARCH_PROVIDER_HOSTS, updateSecurityJson } from "./egress-policy-state.js";
import { loadEgressConfig } from "./network-policy.js";

let dir: string;
const prev = process.env.LAX_DATA_DIR;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "lax-egress-")); process.env.LAX_DATA_DIR = dir; });
afterEach(() => { if (prev === undefined) delete process.env.LAX_DATA_DIR; else process.env.LAX_DATA_DIR = prev; rmSync(dir, { recursive: true, force: true }); });

describe("normalizeEgressHost", () => {
  it("keeps a host or a wildcard on one, drops scheme, path and port, refuses the rest", () => {
    expect(normalizeEgressHost("Api.GitHub.com")).toBe("api.github.com");
    expect(normalizeEgressHost("https://example.com:443/path?q=1")).toBe("example.com");
    expect(normalizeEgressHost("*.npmjs.org")).toBe("*.npmjs.org");
    for (const bad of ["", "localhost", "*", "*.com", "evil com", "http://", "127.0.0.1"]) {
      expect(normalizeEgressHost(bad), bad).toBeNull();
    }
  });
});

describe("EgressPolicyState", () => {
  it("starts permissive with no files, and the files on disk make it strict", () => {
    expect(new EgressPolicyState().snapshot()).toEqual({ mode: "permissive", allowlist: [], configured: false });
    writeFileSync(join(dir, "security.json"), JSON.stringify({ egressMode: "strict" }));
    writeFileSync(join(dir, "egress-allowlist.json"), JSON.stringify(["html.duckduckgo.com"]));
    expect(new EgressPolicyState().snapshot()).toEqual({ mode: "strict", allowlist: ["html.duckduckgo.com"], configured: true });
  });

  it("the setters persist to the files every other reader uses, keeping unrelated keys", () => {
    writeFileSync(join(dir, "security.json"), JSON.stringify({ fileAccessMode: "workspace", localServicePorts: [3000] }));
    writeFileSync(join(dir, "egress-allowlist.json"), "[]");
    const state = new EgressPolicyState();
    state.setMode("strict");
    // The user's own list, empty included, is kept when strict is turned on.
    expect(state.snapshot().allowlist).toEqual([]);
    state.allow("HTTPS://API.GitHub.com/repos");
    state.allow("*.npmjs.org");
    const cfg = JSON.parse(readFileSync(join(dir, "security.json"), "utf-8"));
    expect(cfg).toEqual({ fileAccessMode: "workspace", localServicePorts: [3000], egressMode: "strict" });
    expect(JSON.parse(readFileSync(join(dir, "egress-allowlist.json"), "utf-8"))).toEqual(["*.npmjs.org", "api.github.com"]);
    // The standalone reader (the proxies, the browser worker) sees the same policy.
    const seen = loadEgressConfig();
    expect(seen.mode).toBe("strict");
    expect([...seen.allowlist].sort()).toEqual(["*.npmjs.org", "api.github.com"]);
    state.remove("api.github.com");
    expect(state.snapshot().allowlist).toEqual(["*.npmjs.org"]);
    expect(() => state.allow("not a host")).toThrow(/not a host name/);
  });

  it("turning strict on with no list yet starts the list with the search providers; permissive writes none", () => {
    const state = new EgressPolicyState();
    state.setMode("permissive");
    expect(existsSync(join(dir, "egress-allowlist.json"))).toBe(false);
    expect(state.setMode("strict")).toEqual({ mode: "strict", allowlist: [...SEARCH_PROVIDER_HOSTS].sort(), configured: true });
    // A host the user removed stays removed on the next switch.
    state.remove("commons.wikimedia.org");
    state.setMode("permissive");
    state.setMode("strict");
    expect(state.snapshot().allowlist).not.toContain("commons.wikimedia.org");
  });

  it("the search providers are every host web_search and image_search reach", () => {
    // Read from the tools' own source, so a provider added there and not here
    // fails this test instead of failing search for a user who chose strict.
    const hosts = new Set<string>();
    for (const file of ["src/tools/web-search-tool.ts", "src/tools/image-search-tool.ts"]) {
      for (const m of readFileSync(file, "utf-8").matchAll(/https:\/\/([a-z0-9.-]+)\//g)) hosts.add(m[1]);
    }
    expect(hosts.size).toBeGreaterThan(0);
    expect([...SEARCH_PROVIDER_HOSTS].sort()).toEqual([...hosts].sort());
  });

  it("a file written behind its back (installer, another process, a human) is seen by the next read", () => {
    const state = new EgressPolicyState();
    expect(state.mode).toBe("permissive");
    writeFileSync(join(dir, "security.json"), JSON.stringify({ egressMode: "strict" }));
    writeFileSync(join(dir, "egress-allowlist.json"), JSON.stringify(["docs.example.org"]));
    // No new instance, no restart: the same object now answers from the files.
    expect(state.snapshot()).toEqual({ mode: "strict", allowlist: ["docs.example.org"], configured: true });
    rmSync(join(dir, "egress-allowlist.json"));
    expect(state.configured).toBe(false);
  });

  it("updateSecurityJson creates the file when absent", () => {
    updateSecurityJson({ egressMode: "strict" });
    expect(JSON.parse(readFileSync(join(dir, "security.json"), "utf-8"))).toEqual({ egressMode: "strict" });
  });
});
