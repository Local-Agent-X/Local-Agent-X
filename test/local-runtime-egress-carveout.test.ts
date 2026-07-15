import { describe, it, expect, vi, afterEach } from "vitest";
import { loopbackPortFromUrl, localRuntimeLoopbackPorts } from "../src/security/layer/security-config.js";
import { evaluateWebFetch } from "../src/security/layer/index.js";
import { getLocalRuntimes } from "../src/local-runtimes/cache.js";
import { openaiCompatProbe } from "../src/local-runtimes/openai-compat-probe.js";
import type { LocalRuntimeInfo } from "../src/local-runtimes/types.js";

vi.mock("../src/local-runtimes/cache.js", () => ({
  getLocalRuntimes: vi.fn((): LocalRuntimeInfo[] | null => null),
}));

// The manual-add fold reads settings.json from the LAX data dir; point it
// at an empty tmp dir so a dev box's real manual entries can't sway
// assertions. Must be absolute + outside the repo: config.ts CREATES the
// dir on first read, so a relative path would litter the working tree.
vi.mock("../src/lax-data-dir.js", async () => {
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const dir = join(tmpdir(), "lax-egress-carveout-test");
  return { getLaxDir: () => dir };
});

// Local-runtime evolution of the ollama carve-out: the agent's HTTP tools
// may reach the loopback ports of DISCOVERED local inference runtimes plus
// operator manual-add entries — but ONLY literal-loopback ones. Two
// authorizations must move independently:
//   - the sweep candidate list (openaiCompatProbe.defaultPorts) exists to
//     FIND runtimes and may include common dev ports (5000, 8080);
//   - agent egress is granted per-port only by live discovery evidence.
// A sweep port with no discovered runtime stays blocked — that invariant is
// what lets the sweep list grow without silently widening agent egress.
// Non-loopback runtimes (a LAN GPU box) are chat-routing-only: LAX's own
// fetch reaches them via the admission gate; agent egress there is a
// separate authorization that a settings entry must never silently grant.

function runtimeAt(baseUrl: string): LocalRuntimeInfo {
  return {
    kind: "openai-compat",
    id: `openai-compat@${baseUrl.replace(/^https?:\/\//, "")}`,
    label: "LM Studio",
    endpoint: { baseUrl, origin: "auto" },
    chatBaseUrl: `${baseUrl}/v1`,
    models: [],
    refreshedAt: 0,
  };
}
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

describe("localRuntimeLoopbackPorts — discovery evidence, not sweep candidates", () => {
  afterEach(() => vi.mocked(getLocalRuntimes).mockReturnValue(null));

  it("includes a DISCOVERED runtime's loopback port", () => {
    vi.mocked(getLocalRuntimes).mockReturnValue([runtimeAt("http://127.0.0.1:1234")]);
    expect(localRuntimeLoopbackPorts().has("1234")).toBe(true);
  });

  it("a path-prefixed discovered runtime (Docker Model Runner) contributes its port", () => {
    vi.mocked(getLocalRuntimes).mockReturnValue([runtimeAt("http://127.0.0.1:12434/engines")]);
    expect(localRuntimeLoopbackPorts().has("12434")).toBe(true);
  });

  it("INVARIANT: sweep candidate ports grant NO egress until discovered there", () => {
    vi.mocked(getLocalRuntimes).mockReturnValue([]);
    const ports = localRuntimeLoopbackPorts();
    for (const swept of openaiCompatProbe.defaultPorts) {
      expect(ports.has(String(swept))).toBe(false);
    }
  });

  it("a discovered NON-loopback runtime contributes nothing (LAN box is chat-only)", () => {
    vi.mocked(getLocalRuntimes).mockReturnValue([runtimeAt("http://192.168.1.50:1234")]);
    expect(localRuntimeLoopbackPorts().has("1234")).toBe(false);
  });

  it("cold cache (never populated) → manual-adds-only, never throws", () => {
    vi.mocked(getLocalRuntimes).mockReturnValue(null);
    expect(localRuntimeLoopbackPorts().has("1234")).toBe(false);
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
