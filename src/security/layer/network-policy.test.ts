import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { promises as dns } from "node:dns";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { resolveAndPinHost, validateUrlWithDns, evaluateWebFetch, evaluateEgressForUrl } from "./network-policy.js";
import {
  BLOCKED_HOSTNAMES,
  SPECIAL_USE_IPV4_RANGES,
  SPECIAL_USE_IPV6_RANGES,
  isPrivateIPv4,
  isPrivateIPv6,
} from "./ip-classification.js";

const EMPTY_ALLOWLIST = new Set<string>();

/** Run the synchronous web-fetch policy in permissive mode (no disk access). */
function webFetch(url: string) {
  return evaluateWebFetch(EMPTY_ALLOWLIST, false, "7007", url, "permissive");
}

describe("special-purpose IP classification", () => {
  it.each(SPECIAL_USE_IPV4_RANGES)("blocks IPv4 table range $cidr ($reason)", ({ cidr }) => {
    expect(isPrivateIPv4(cidr.split("/")[0])).toBe(true);
  });

  it.each([
    "192.0.2.77",
    "198.19.255.254",
    "198.51.100.42",
    "203.0.113.99",
    "233.252.0.1",
    "250.1.2.3",
  ])("blocks representative special-purpose IPv4 %s", (ip) => {
    expect(isPrivateIPv4(ip)).toBe(true);
  });

  it.each(["1.1.1.1", "8.8.8.8", "93.184.216.34"])("allows global IPv4 %s", (ip) => {
    expect(isPrivateIPv4(ip)).toBe(false);
  });

  it.each(SPECIAL_USE_IPV6_RANGES)("blocks IPv6 table range $cidr ($reason)", ({ cidr }) => {
    expect(isPrivateIPv6(cidr.split("/")[0])).toBe(true);
  });

  it.each([
    "100::dead:beef",
    "2001:2::1",
    "2001:db8:abcd::1",
    "2002:c0a8:0101::1",
    "2620:4f:8000::1234",
    "3fff:abc::1",
    "5f00::1",
    "ff02::1",
    "4000::1",
  ])("blocks representative special-purpose IPv6 %s", (ip) => {
    expect(isPrivateIPv6(ip)).toBe(true);
  });

  it.each(["2001:4860:4860::8888", "2606:4700:4700::1111"])("allows global IPv6 %s", (ip) => {
    expect(isPrivateIPv6(ip)).toBe(false);
  });

  it("blocks IPv4-mapped IPv6 as special-purpose regardless of payload", () => {
    expect(isPrivateIPv6("::ffff:198.51.100.7")).toBe(true);
    expect(isPrivateIPv6("::ffff:8.8.8.8")).toBe(true);
  });
});

describe("resolveAndPinHost", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns { ok: true, pin: null } for a PUBLIC literal IPv4 (nothing to resolve)", async () => {
    const result = await resolveAndPinHost("93.184.216.34");
    expect(result).toEqual({ ok: true, pin: null });
  });

  // SSRF-via-redirect (finding H5): a 302 to a literal private/metadata IP must
  // be blocked HERE, because this guard is the chokepoint every redirect hop
  // passes through (evaluateWebFetch only validates the original URL).
  it.each([
    ["169.254.169.254"], // cloud metadata (link-local)
    ["127.0.0.1"],       // loopback
    ["10.0.0.5"],        // RFC1918 private
    ["192.168.1.1"],     // RFC1918 private
  ])("blocks literal private/metadata IPv4 %s", async (ip) => {
    const result = await resolveAndPinHost(ip);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("SSRF protection");
  });

  it("blocks a literal IPv6 loopback [::1]", async () => {
    const result = await resolveAndPinHost("[::1]");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("SSRF protection");
  });

  it("blocks an IPv4-mapped IPv6 literal for the metadata IP (::ffff:169.254.169.254)", async () => {
    const result = await resolveAndPinHost("::ffff:169.254.169.254");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("SSRF protection");
  });

  // Pin resolver outcomes so host-machine DNS cannot change this security contract.
  it("blocks 'localhost' when DNS resolves it to loopback", async () => {
    vi.spyOn(dns, "resolve4").mockResolvedValue(["127.0.0.1"]);
    vi.spyOn(dns, "resolve6").mockResolvedValue([]);

    const result = await resolveAndPinHost("localhost");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain("DNS rebinding protection");
    }
  });

  it("fails closed for a host that never resolves (.invalid TLD)", async () => {
    vi.spyOn(dns, "resolve4").mockResolvedValue([]);
    vi.spyOn(dns, "resolve6").mockResolvedValue([]);

    const result = await resolveAndPinHost("nonexistent-host-xyz.invalid");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain("fail-closed SSRF protection");
    }
  });
});

// Round-3 finding C3-5: NAT64 (64:ff9b::/96, RFC6052) and 6to4 (2002::/16,
// RFC3056) IPv6 literals embed an IPv4 address. A literal like
// 64:ff9b::169.254.169.254 or 2002:a9fe:a9fe:: dials the embedded IPv4 (here,
// cloud metadata) while looking like a benign public IPv6 host. isPrivateIPv6
// decodes the embedded IPv4 and classifies by it: private/reserved/metadata
// embeds are blocked, public embeds pass (NAT64 is how IPv6-only networks
// reach the IPv4 internet — a blanket block breaks them).
describe("evaluateWebFetch — NAT64/6to4 embedded-IPv4 SSRF (C3-5)", () => {
  it.each([
    ["[64:ff9b::169.254.169.254]", "NAT64 dotted-tail → AWS metadata"],
    ["[64:ff9b::a9fe:a9fe]", "NAT64 hex-tail → AWS metadata (same address)"],
    ["[64:ff9b:1::169.254.169.254]", "NAT64 local-use prefix → metadata"],
    ["[2002:a9fe:a9fe::]", "6to4 → 169.254.169.254 metadata"],
    ["[2002:0a00:0001::]", "6to4 → 10.0.0.1 RFC1918 private"],
    ["[2002:7f00:0001::]", "6to4 → 127.0.0.1 loopback"],
  ])("blocks %s (%s)", (host) => {
    const d = webFetch(`http://${host}/`);
    expect(d.allowed).toBe(false);
    expect(d.reason).toContain("private/reserved IPv6");
  });

  it.each([
    ["[2606:4700:4700::1111]", "Cloudflare public IPv6 — not a transition literal"],
    ["[2002:0808:0808::]", "6to4 wrapping public 8.8.8.8"],
    ["[64:ff9b::8.8.8.8]", "NAT64 wrapping public 8.8.8.8"],
    ["[64:ff9b:1::1.1.1.1]", "NAT64 local-use prefix wrapping public 1.1.1.1"],
  ])("allows %s (%s)", (host) => {
    const d = webFetch(`http://${host}/`);
    expect(d.allowed).toBe(true);
  });

  // The dispatcher path (resolveAndPinHost) shares isPrivateIPv6, so the same
  // literals are blocked there too — closing the redirect-hop SSRF (C3-23).
  it("resolveAndPinHost blocks a NAT64 metadata literal", async () => {
    const result = await resolveAndPinHost("64:ff9b::169.254.169.254");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("SSRF protection");
  });

  it("resolveAndPinHost allows 6to4 wrapping a public IPv4", async () => {
    const result = await resolveAndPinHost("2002:0808:0808::");
    expect(result).toEqual({ ok: true, pin: null });
  });
});

describe("validateUrlWithDns — literal-IP regression", () => {
  it("allows a self-call to the agent's own server (literal IPv4 path)", async () => {
    const selfPort = "7007";
    const decision = await validateUrlWithDns(
      EMPTY_ALLOWLIST,
      false,
      selfPort,
      `http://127.0.0.1:${selfPort}/x`,
      "permissive",
    );
    expect(decision.allowed).toBe(true);
  });

  it("allows an IPv6 loopback self-call to the agent's own server", async () => {
    const decision = await validateUrlWithDns(
      EMPTY_ALLOWLIST,
      false,
      "7007",
      "http://[::1]:7007/x",
      "permissive",
    );
    expect(decision.allowed).toBe(true);
  });

  it("still blocks a private literal IPv4 (10.0.0.0/8)", async () => {
    const decision = await validateUrlWithDns(
      EMPTY_ALLOWLIST,
      false,
      "7007",
      "http://10.0.0.1/",
      "permissive",
    );
    expect(decision.allowed).toBe(false);
  });
});

// R4-17 (defense-in-depth): WHATWG `new URL()` PRESERVES a trailing dot on a
// non-IP host, so `metadata.google.internal.` is a distinct hostname string
// from `metadata.google.internal` even though DNS treats them identically. The
// synchronous gate must canonicalize the host (lowercase + strip a single
// trailing dot) so a trailing-dot blocked host can't slip an ALLOW past a
// future http-class tool that trusts the synchronous verdict without a DNS pin.
describe("evaluateWebFetch — trailing-dot host canonicalization (R4-17)", () => {
  // Iterate the ACTUAL blocklist constant so this assertion can't drift if the
  // list grows. For every entry, the dotless and dotted forms must yield the
  // SAME verdict (both blocked).
  it.each([...BLOCKED_HOSTNAMES])("blocks both %s and its trailing-dot form identically", (h) => {
    const dotless = webFetch(`http://${h}/`);
    const dotted = webFetch(`http://${h}./`);
    expect(dotted.allowed).toBe(dotless.allowed);
    expect(dotted.allowed).toBe(false);
  });

  // Regression: a normal allowlisted PUBLIC host typed with a trailing dot must
  // still match its allow entry in strict mode (no new false-positive block of
  // legitimate traffic).
  it("still ALLOWS an allowlisted public host typed with a trailing dot (strict mode)", () => {
    const allowlist = new Set<string>(["example.com"]);
    const decision = evaluateWebFetch(allowlist, true, "7007", "http://example.com./", "strict");
    expect(decision.allowed).toBe(true);
  });
});

// ── C7: operator-added local runtime host:port carve-out ──────────────────
// settings.localRuntimes entries are the operator's exact-host:port statement
// "LAX may talk to this inference endpoint". The admission gate consumes them
// for LAX's own probe/chat fetches; evaluateWebFetch consumes the SAME
// validated set (security-config manualRuntimeHostPorts → endpoints.ts
// manualAllowlist) so the agent's HTTP tools agree. These pin the boundaries:
// exact host:port only, no range widening, SSRF-shape blocks unaffected.
describe("evaluateWebFetch — operator-named local runtime carve-out (C7)", () => {
  const named = (url: string, entries: string[], mode: "permissive" | "strict" = "permissive") =>
    evaluateWebFetch(EMPTY_ALLOWLIST, mode === "strict", "7007", url, mode, new Set(), new Set(entries));

  it("allows an exact-named private IPv4 host:port (the LAN GPU box case)", () => {
    const d = named("http://192.168.1.50:11434/api/tags", ["192.168.1.50:11434"]);
    expect(d.allowed).toBe(true);
    expect(d.reason).toContain("operator-added local runtime");
  });

  it("blocks the same host on a DIFFERENT port — exact matching, no host-wide widening", () => {
    expect(named("http://192.168.1.50:8080/", ["192.168.1.50:11434"]).allowed).toBe(false);
  });

  it("blocks OTHER private hosts when one is named — no range admission", () => {
    expect(named("http://192.168.1.51:11434/", ["192.168.1.50:11434"]).allowed).toBe(false);
    expect(named("http://10.0.0.7:11434/", ["192.168.1.50:11434"]).allowed).toBe(false);
  });

  it("empty set preserves the existing private-range block exactly", () => {
    const d = webFetch("http://192.168.1.50:11434/");
    expect(d.allowed).toBe(false);
    expect(d.reason).toContain("private/reserved IPv4");
  });

  it("cloud metadata stays blocked even when named (link-local IP and .internal alias)", () => {
    expect(named("http://169.254.169.254:80/", ["169.254.169.254:80"]).allowed).toBe(false);
    expect(named("http://metadata.google.internal:80/", ["metadata.google.internal:80"]).allowed).toBe(false);
  });

  it("blocked hostnames stay blocked even when named (localhost is not a nameable entry)", () => {
    expect(named("http://localhost:11434/", ["localhost:11434"]).allowed).toBe(false);
  });

  it("strict egress mode: a named runtime passes without an egress-allowlist entry", () => {
    const d = named("http://192.168.1.50:11434/v1/chat/completions", ["192.168.1.50:11434"], "strict");
    expect(d.allowed).toBe(true);
    // ...and strict mode still blocks unnamed public hosts in the same call shape.
    expect(named("http://example.org/", ["192.168.1.50:11434"], "strict").allowed).toBe(false);
  });

  it("default ports normalize identically on both sides (entry without explicit port)", () => {
    expect(named("http://192.168.1.50/", ["192.168.1.50:80"]).allowed).toBe(true);
  });

  it("IPv6 unique-local literals match via bracketed WHATWG normalization", () => {
    expect(named("http://[fd12:3456::7]:8000/v1/models", ["[fd12:3456::7]:8000"]).allowed).toBe(true);
    expect(named("http://[fd12:3456::8]:8000/", ["[fd12:3456::7]:8000"]).allowed).toBe(false);
  });
});

// The full contract the admission-gate header promises: an operator entry in
// settings.localRuntimes ⇒ the AGENT's HTTP tools may egress to that exact
// host:port. Exercises the real disk seam (loadEgressConfig → evaluateWebFetch)
// against an isolated LAX_DATA_DIR — the same per-call path the connect-time
// re-checks (web-egress, browser guards, egress proxy, integrations) run.
describe("egress fold contract — settings.localRuntimes ⇒ evaluateEgressForUrl (C7)", () => {
  let dir: string;
  let prev: string | undefined;
  beforeEach(() => {
    prev = process.env.LAX_DATA_DIR;
    dir = mkdtempSync(join(tmpdir(), "lax-c7-"));
    process.env.LAX_DATA_DIR = dir;
  });
  afterEach(() => {
    if (prev === undefined) delete process.env.LAX_DATA_DIR;
    else process.env.LAX_DATA_DIR = prev;
    rmSync(dir, { recursive: true, force: true });
  });

  it("a manual non-loopback entry becomes agent-egress-allowed; removing it re-blocks", () => {
    // Before the entry exists: blocked (private range).
    expect(evaluateEgressForUrl("http://192.168.1.50:11434/api/tags").allowed).toBe(false);

    writeFileSync(join(dir, "settings.json"), JSON.stringify({
      localRuntimes: [{ kind: "ollama", baseUrl: "http://192.168.1.50:11434", label: "GPU box" }],
    }));
    const d = evaluateEgressForUrl("http://192.168.1.50:11434/api/tags");
    expect(d.allowed).toBe(true);
    expect(d.reason).toContain("192.168.1.50:11434");
    // Sibling host / other port stay blocked — one entry admits ONE host:port.
    expect(evaluateEgressForUrl("http://192.168.1.51:11434/").allowed).toBe(false);
    expect(evaluateEgressForUrl("http://192.168.1.50:8080/").allowed).toBe(false);

    // Operator delete re-blocks immediately — the set is re-read per decision.
    writeFileSync(join(dir, "settings.json"), JSON.stringify({ localRuntimes: [] }));
    expect(evaluateEgressForUrl("http://192.168.1.50:11434/api/tags").allowed).toBe(false);
  });

  it("malformed settings entries never admit anything (validation lives in endpoints.ts alone)", () => {
    writeFileSync(join(dir, "settings.json"), JSON.stringify({
      localRuntimes: [
        { kind: "bogus", baseUrl: "http://192.168.1.50:11434" },
        { kind: "ollama", baseUrl: "not a url" },
        "garbage",
      ],
    }));
    expect(evaluateEgressForUrl("http://192.168.1.50:11434/").allowed).toBe(false);
  });
});
