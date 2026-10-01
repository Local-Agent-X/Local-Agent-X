// canonicalFetch is the one hardened fetch for every off-box read that has no
// URL argument the dispatch gate could judge (web_search, image_search, image
// acquisition for a deck). It applies the web-access policy to the initial
// destination before dialing, so strict mode holds there too, and the error
// carries the policy's action so the tool can offer "Allow <host> & retry".
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assertInitialEgressAllowed, canonicalFetch, EgressRedirectBlocked } from "./web-egress.js";

let dir: string;
const prev = process.env.LAX_DATA_DIR;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "lax-egress-fetch-")); process.env.LAX_DATA_DIR = dir; });
afterEach(() => { if (prev === undefined) delete process.env.LAX_DATA_DIR; else process.env.LAX_DATA_DIR = prev; rmSync(dir, { recursive: true, force: true }); });

function strict(allow: string[]): void {
  writeFileSync(join(dir, "security.json"), JSON.stringify({ egressMode: "strict" }));
  writeFileSync(join(dir, "egress-allowlist.json"), JSON.stringify(allow));
}

describe("canonicalFetch applies the web-access policy to its first destination", () => {
  it("strict mode refuses a host off the allowlist before any dial, with the host to allow", async () => {
    strict(["allowed.example"]);
    let thrown: unknown;
    // A host that does not resolve: a rejection from DNS would be a different
    // error, so this proves the policy answered first.
    try { await canonicalFetch("https://html.duckduckgo.invalid/html/?q=x", { timeoutMs: 2_000 }); } catch (e) { thrown = e; }
    expect(thrown).toBeInstanceOf(EgressRedirectBlocked);
    const e = thrown as EgressRedirectBlocked;
    expect(e.action).toEqual({ kind: "allow-host", host: "html.duckduckgo.invalid" });
    expect(e.message).toMatch(/not on the web access allowlist/);
  });

  it("strict mode lets an allowlisted host through the policy (the dial itself is the next step)", () => {
    strict(["html.duckduckgo.com"]);
    expect(() => assertInitialEgressAllowed("https://html.duckduckgo.com/html/?q=x")).not.toThrow();
    expect(() => assertInitialEgressAllowed("https://api.search.brave.com/res/v1/web/search?q=x")).toThrow(EgressRedirectBlocked);
  });

  it("permissive mode has no allowlist to refuse on, and loopback is left to the port-aware check", () => {
    expect(() => assertInitialEgressAllowed("https://docs.example.org/")).not.toThrow();
    expect(() => assertInitialEgressAllowed("http://127.0.0.1:7007/api/health")).not.toThrow();
    expect(() => assertInitialEgressAllowed("http://localhost:3000/")).not.toThrow();
  });

  it("a cloud-metadata or private literal is still refused, without an action", () => {
    expect(() => assertInitialEgressAllowed("not a url")).toThrow(EgressRedirectBlocked);
  });
});
