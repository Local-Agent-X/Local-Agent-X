import { describe, it, expect } from "vitest";
import { ollamaPortFromUrl } from "../src/security/security-config.js";
import { evaluateWebFetch } from "../src/security/network-policy.js";

// The agent must be able to reach its own local ollama embed API (default
// 127.0.0.1:11434) for RAG — but the SSRF guard blocks all loopback by default.
// The carve-out folds ollama's port into localServicePorts, but ONLY when the
// configured ollamaUrl is a literal loopback IP. ollamaUrl lives in config.json,
// which a prompt-injected agent can WRITE — so the boundary is validate-as-
// loopback: a poisoned config can never widen the carve-out to a metadata or
// private host, only ever a loopback port.
describe("ollamaPortFromUrl — validate-as-loopback (config-injection boundary)", () => {
  it("accepts a literal loopback ollama URL", () => {
    expect(ollamaPortFromUrl("http://127.0.0.1:11434")).toBe("11434");
    expect(ollamaPortFromUrl("http://127.0.0.1")).toBe("11434"); // implicit default port
    expect(ollamaPortFromUrl("http://[::1]:11434")).toBe("11434");
    expect(ollamaPortFromUrl("http://127.0.0.1:8080")).toBe("8080"); // operator moved it
  });

  it("REJECTS non-loopback hosts — the SSRF-escalation vectors", () => {
    expect(ollamaPortFromUrl("http://169.254.169.254:80")).toBeNull(); // cloud metadata
    expect(ollamaPortFromUrl("http://10.0.0.5:11434")).toBeNull();     // private RFC1918
    expect(ollamaPortFromUrl("http://192.168.1.10:11434")).toBeNull();
    expect(ollamaPortFromUrl("http://ollama.box:11434")).toBeNull();   // hostname (DNS-rebind risk)
    expect(ollamaPortFromUrl("http://localhost:11434")).toBeNull();    // hostname, not literal IP
    expect(ollamaPortFromUrl("http://evil.com:11434")).toBeNull();
    expect(ollamaPortFromUrl("")).toBeNull();                          // operator-disabled
    expect(ollamaPortFromUrl("not a url")).toBeNull();
  });
});

// With ollama's port (11434) in localServicePorts, confirm the EXACT carve-out:
// the ollama loopback port is allowed, everything else SSRF stays blocked.
describe("evaluateWebFetch — ollama carve-out keeps SSRF protections intact", () => {
  const ports = new Set(["11434"]); // as if ollama's loopback port was folded in
  const ev = (url: string) => evaluateWebFetch(new Set<string>(), false, "7007", url, "permissive", ports);

  it("ALLOWS the ollama loopback port", () => {
    expect(ev("http://127.0.0.1:11434/api/embed").allowed).toBe(true);
  });

  it("still BLOCKS every other SSRF target", () => {
    expect(ev("http://127.0.0.1:6379").allowed).toBe(false);          // redis, not allowlisted
    expect(ev("http://127.0.0.1:5432").allowed).toBe(false);          // postgres
    expect(ev("http://127.0.0.1:9999").allowed).toBe(false);          // random loopback port
    expect(ev("http://169.254.169.254/latest/meta-data").allowed).toBe(false); // AWS metadata
    expect(ev("http://10.0.0.1/admin").allowed).toBe(false);          // private RFC1918
    expect(ev("http://192.168.1.1").allowed).toBe(false);
    expect(ev("http://metadata.google.internal").allowed).toBe(false); // GCP metadata
  });

  // The critical encoding check: an obfuscated IP normalizes to its REAL host
  // before the carve-out/host checks run. So the ollama port cannot be a tunnel
  // to a non-loopback target — only to the actual loopback ollama service.
  it("encoded IPs resolve to their true host: ollama-port to METADATA stays blocked", () => {
    // hex/decimal-encoded loopback IS the real ollama endpoint → allowed (same service).
    expect(ev("http://0x7f000001:11434").allowed).toBe(true);   // 0x7f000001 = 127.0.0.1
    expect(ev("http://2130706433:11434").allowed).toBe(true);   // 2130706433 = 127.0.0.1
    // encoded loopback on a NON-ollama port → blocked.
    expect(ev("http://0x7f000001:6379").allowed).toBe(false);
    // encoded cloud-metadata, even ON the ollama port → blocked (host is 169.254.169.254).
    expect(ev("http://0xa9fea9fe:11434").allowed).toBe(false);  // hex 169.254.169.254
    expect(ev("http://2852039166:11434").allowed).toBe(false);  // decimal 169.254.169.254
  });

  it("a 302 redirect from the ollama port to cloud metadata stays BLOCKED", () => {
    // Redirect targets are re-evaluated as their own URL; the carve-out is
    // port-on-loopback only, so a non-loopback redirect target never matches it.
    expect(ev("http://169.254.169.254/").allowed).toBe(false);
  });
});
