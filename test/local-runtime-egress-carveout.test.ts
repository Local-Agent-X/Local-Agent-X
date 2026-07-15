import { describe, it, expect, vi, afterEach } from "vitest";
import { loopbackPortFromUrl, localRuntimeLoopbackPorts } from "../src/security/layer/security-config.js";
import { evaluateWebFetch } from "../src/security/layer/index.js";

// Local-runtime evolution of the ollama carve-out: the agent's HTTP tools
// may reach the loopback ports of local inference runtimes (LM Studio 1234,
// vLLM 8000, llama.cpp 8080 — same standing as ollama's 11434) plus
// operator manual-add entries — but ONLY literal-loopback ones. Non-loopback
// manual runtimes (a LAN GPU box) are chat-routing-only: LAX's own fetch
// reaches them via the admission gate; agent egress there is a separate
// authorization that a settings entry must never silently grant.
describe("loopbackPortFromUrl — literal loopback, explicit port only", () => {
  it("accepts literal loopback with explicit port", () => {
    expect(loopbackPortFromUrl("http://127.0.0.1:1234")).toBe("1234");
    expect(loopbackPortFromUrl("http://[::1]:8000")).toBe("8000");
  });

  it("REJECTS hostnames (incl. localhost — DNS-rebind boundary), private IPs, and portless URLs", () => {
    expect(loopbackPortFromUrl("http://localhost:1234")).toBeNull();
    expect(loopbackPortFromUrl("http://192.168.1.50:8000")).toBeNull();
    expect(loopbackPortFromUrl("http://169.254.169.254:80")).toBeNull();
    expect(loopbackPortFromUrl("http://gpubox:1234")).toBeNull();
    expect(loopbackPortFromUrl("http://127.0.0.1")).toBeNull(); // no explicit port
    expect(loopbackPortFromUrl("garbage")).toBeNull();
  });
});

describe("localRuntimeLoopbackPorts", () => {
  afterEach(() => vi.restoreAllMocks());

  it("always includes every probe's default sweep port", () => {
    const ports = localRuntimeLoopbackPorts();
    expect(ports.has("11434")).toBe(true); // ollama probe
    expect(ports.has("1234")).toBe(true);  // LM Studio
    expect(ports.has("8000")).toBe(true);  // vLLM
    expect(ports.has("8080")).toBe(true);  // llama.cpp
  });
});

describe("evaluateWebFetch — runtime carve-out keeps SSRF protections intact", () => {
  const ports = new Set(["11434", "1234"]);
  const ev = (url: string) => evaluateWebFetch(new Set<string>(), false, "7007", url, "permissive", ports);

  it("ALLOWS the folded runtime loopback ports", () => {
    expect(ev("http://127.0.0.1:1234/v1/models").allowed).toBe(true);
    expect(ev("http://127.0.0.1:11434/api/tags").allowed).toBe(true);
  });

  it("still BLOCKS everything the carve-out must not widen", () => {
    expect(ev("http://127.0.0.1:9999/").allowed).toBe(false);          // un-carved loopback port
    expect(ev("http://192.168.1.50:1234/v1/models").allowed).toBe(false); // carved PORT on a LAN host
    expect(ev("http://169.254.169.254:1234/").allowed).toBe(false);    // metadata host, carved port
  });
});
