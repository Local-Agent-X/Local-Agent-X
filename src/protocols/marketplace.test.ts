// The protocol registry is fetched through the hardened transport like every
// other off-box read: web access (strict mode's allowlist), DNS pinning, and
// the redirect checks. A refusal leaves the agent with the cached or empty
// registry, as any other failure does.
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "lax-marketplace-"));
process.env.LAX_DATA_DIR = dir;

const net = vi.hoisted(() => ({ calls: [] as string[], fn: null as null | ((url: string) => Promise<unknown>) }));
vi.mock("../tools/web-egress.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../tools/web-egress.js")>()),
  canonicalFetch: (url: string) => { net.calls.push(url); return net.fn!(url); },
}));
const { fetchRegistry, installProtocol } = await import("./marketplace.js");
const { readTrashRecord } = await import("../safe-delete.js");
const { loadCustomProtocols } = await import("./builder.js");

beforeEach(() => {
  net.calls.length = 0;
  rmSync(join(dir, "marketplace-cache.json"), { force: true });
  vi.stubGlobal("fetch", async () => { throw new Error("global fetch reached: the registry bypassed the hardened transport"); });
});
afterAll(() => { vi.unstubAllGlobals(); rmSync(dir, { recursive: true, force: true }); });

const ENTRY = { name: "x", description: "d", author: "a", version: "1", tags: [], downloads: 0, protocol: {} };

describe("fetchRegistry", () => {
  it("reads the registry through the hardened transport", async () => {
    net.fn = async () => ({ ok: true, json: async () => [ENTRY] });
    expect(await fetchRegistry()).toEqual([ENTRY]);
    expect(net.calls).toEqual(["https://raw.githubusercontent.com/local-agent-x/protocol-marketplace/main/registry.json"]);
  });

  it("a refused fetch leaves an empty registry rather than failing the caller", async () => {
    net.fn = async () => { throw new Error("Blocked: raw.githubusercontent.com is not on the web access allowlist (strict mode)."); };
    expect(await fetchRegistry()).toEqual([]);
  });
});

// marketplace_install is classed recoverable (no irreversible card) because an
// install never destroys someone's own protocol: the one it replaces is kept.
describe("installProtocol", () => {
  const entry = (description: string) => ({ ...ENTRY, protocol: { name: "deploy-check", description, steps: [] } }) as never;

  it("keeps the protocol it replaces in the recycle bin, and a first install replaces nothing", () => {
    installProtocol(entry("mine"));
    expect(readTrashRecord("protocol-deploy-check")).toBeNull();
    installProtocol(entry("from the marketplace"));
    expect(readTrashRecord<{ description: string }>("protocol-deploy-check")?.description).toBe("mine");
    expect(loadCustomProtocols().find((p) => p.name === "deploy-check")?.description).toBe("from the marketplace");
  });
});
