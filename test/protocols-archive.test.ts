import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setRuntimeConfig, getRuntimeConfig } from "../src/config.js";
import type { LAXConfig } from "../src/types.js";
import {
  archiveProtocol, unarchiveProtocol, purgeArchivedProtocol,
  loadArchived, computeProtocolState, applyAutomaticTransitions,
} from "../src/protocols/archive.js";
import {
  createProtocol, loadCustomProtocols, saveCustomProtocols, editProtocol,
} from "../src/protocols/builder.js";
import { recordUsage } from "../src/protocols/usage.js";
import type { Protocol } from "../src/protocols/types.js";

const DAY = 86_400_000;

let TEMP: string;
let ORIGINAL_CFG: LAXConfig;

beforeAll(() => {
  TEMP = mkdtempSync(join(tmpdir(), "lax-archive-test-"));
  ORIGINAL_CFG = getRuntimeConfig();
  setRuntimeConfig({ ...ORIGINAL_CFG, workspace: TEMP } as LAXConfig);
});

beforeEach(() => {
  // Fresh state per test — wipe and reset custom + archived + usage files.
  saveCustomProtocols([]);
  // archived.json + usage.jsonl deleted via temp dir reset would be cleaner,
  // but here we just clear them in-place to keep TEMP stable across tests.
  const archived = join(TEMP, "protocols", "archived.json");
  if (existsSync(archived)) rmSync(archived);
  const usage = join(TEMP, "protocols", "usage.jsonl");
  if (existsSync(usage)) rmSync(usage);
});

afterAll(() => {
  setRuntimeConfig(ORIGINAL_CFG);
  rmSync(TEMP, { recursive: true, force: true });
});

function mkProtocol(name: string, extra: Partial<Protocol> = {}): Protocol {
  return {
    name,
    description: `${name} description`,
    triggers: [name, `trigger ${name}`],
    steps: [{ id: "s1", instruction: "do thing" }],
    rules: [],
    learnablePreferences: [],
    ...extra,
  };
}

describe("archiveProtocol", () => {
  it("moves a live custom protocol into archived.json", () => {
    createProtocol(mkProtocol("alpha"));
    expect(loadCustomProtocols().map((p) => p.name)).toContain("alpha");
    expect(loadArchived()).toEqual([]);

    const rec = archiveProtocol("alpha", "test reason");
    expect(rec).not.toBeNull();
    expect(rec!.protocol.name).toBe("alpha");
    expect(rec!.reason).toBe("test reason");
    expect(loadCustomProtocols().map((p) => p.name)).not.toContain("alpha");
    const archived = loadArchived();
    expect(archived).toHaveLength(1);
    expect(archived[0].protocol.name).toBe("alpha");
  });

  it("returns null if the name isn't in the live catalog", () => {
    expect(archiveProtocol("does-not-exist")).toBeNull();
  });

  it("persists archived.json as valid JSON with archivedTs", () => {
    createProtocol(mkProtocol("beta"));
    archiveProtocol("beta");
    const raw = readFileSync(join(TEMP, "protocols", "archived.json"), "utf-8");
    const parsed = JSON.parse(raw);
    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed[0].archivedTs).toBeGreaterThan(0);
    expect(parsed[0].protocol.name).toBe("beta");
  });
});

describe("unarchiveProtocol", () => {
  it("restores an archived protocol to the live catalog", () => {
    createProtocol(mkProtocol("gamma"));
    archiveProtocol("gamma");
    expect(loadCustomProtocols()).toHaveLength(0);

    const r = unarchiveProtocol("gamma");
    expect(r.error).toBeUndefined();
    expect(r.restored?.name).toBe("gamma");
    expect(loadCustomProtocols().map((p) => p.name)).toContain("gamma");
    expect(loadArchived()).toHaveLength(0);
  });

  it("refuses to overwrite a live protocol of the same name", () => {
    createProtocol(mkProtocol("delta"));
    archiveProtocol("delta");
    createProtocol(mkProtocol("delta", { description: "new version" }));
    const r = unarchiveProtocol("delta");
    expect(r.error).toBeDefined();
    expect(r.restored).toBeUndefined();
    // Archive entry untouched
    expect(loadArchived()).toHaveLength(1);
  });

  it("returns an error for unknown names", () => {
    expect(unarchiveProtocol("never-existed").error).toMatch(/not archived/);
  });
});

describe("purgeArchivedProtocol", () => {
  it("hard-removes the archived record", () => {
    createProtocol(mkProtocol("epsilon"));
    archiveProtocol("epsilon");
    expect(loadArchived()).toHaveLength(1);
    expect(purgeArchivedProtocol("epsilon")).toBe(true);
    expect(loadArchived()).toHaveLength(0);
  });

  it("returns false for names not in archive", () => {
    expect(purgeArchivedProtocol("nope")).toBe(false);
  });
});

describe("computeProtocolState", () => {
  const archivedNames = new Set(["arch-a"]);

  it("returns archived if name is in archive set", () => {
    expect(computeProtocolState("arch-a", { archivedNames, lastInvokedDaysAgo: 0 })).toBe("archived");
  });

  it("returns stale when never invoked (lastInvokedDaysAgo === null)", () => {
    expect(computeProtocolState("x", { archivedNames, lastInvokedDaysAgo: null })).toBe("stale");
  });

  it("returns active when invoked within stale cutoff", () => {
    expect(computeProtocolState("x", { archivedNames, lastInvokedDaysAgo: 5 })).toBe("active");
    expect(computeProtocolState("x", { archivedNames, lastInvokedDaysAgo: 29 })).toBe("active");
  });

  it("returns stale at or past the cutoff", () => {
    expect(computeProtocolState("x", { archivedNames, lastInvokedDaysAgo: 30 })).toBe("stale");
    expect(computeProtocolState("x", { archivedNames, lastInvokedDaysAgo: 365 })).toBe("stale");
  });

  it("honors a custom staleAfterDays threshold", () => {
    expect(computeProtocolState("x", { archivedNames, lastInvokedDaysAgo: 8, staleAfterDays: 7 })).toBe("stale");
    expect(computeProtocolState("x", { archivedNames, lastInvokedDaysAgo: 8, staleAfterDays: 14 })).toBe("active");
  });
});

describe("applyAutomaticTransitions", () => {
  it("does nothing on an empty catalog", () => {
    const r = applyAutomaticTransitions();
    expect(r.archived).toHaveLength(0);
    expect(r.purged).toHaveLength(0);
    expect(r.scanned).toBe(0);
  });

  it("archives custom protocols whose last invocation predates archiveAfterDays", () => {
    createProtocol(mkProtocol("ancient"));
    createProtocol(mkProtocol("fresh"));
    // Recent invocation for "fresh"
    recordUsage({ action: "invoked", name: "fresh" });
    // Force "ancient" to look 100 days stale by writing a stale invocation row.
    const usagePath = join(TEMP, "protocols", "usage.jsonl");
    const oldTs = Date.now() - 100 * DAY;
    appendFileSync(usagePath, JSON.stringify({ ts: oldTs, action: "invoked", name: "ancient" }) + "\n");

    const r = applyAutomaticTransitions({ archiveAfterDays: 90 });
    const names = r.archived.map((a) => a.name);
    expect(names).toContain("ancient");
    expect(names).not.toContain("fresh");
  });

  it("skips pinned protocols", () => {
    createProtocol(mkProtocol("pinned-stale", { pinned: true }));
    const usagePath = join(TEMP, "protocols", "usage.jsonl");
    const oldTs = Date.now() - 200 * DAY;
    appendFileSync(usagePath, JSON.stringify({ ts: oldTs, action: "invoked", name: "pinned-stale" }) + "\n");

    const r = applyAutomaticTransitions({ archiveAfterDays: 30 });
    expect(r.archived.map((a) => a.name)).not.toContain("pinned-stale");
    expect(r.skippedPinned).toBeGreaterThan(0);
  });

  it("purges archive records older than purgeArchivedAfterDays", () => {
    createProtocol(mkProtocol("old-arch"));
    archiveProtocol("old-arch");
    // Manually rewrite the archive entry's timestamp to be 40 days old.
    const archPath = join(TEMP, "protocols", "archived.json");
    const arr = JSON.parse(readFileSync(archPath, "utf-8"));
    arr[0].archivedTs = Date.now() - 40 * DAY;
    writeFileSync(archPath, JSON.stringify(arr));

    const r = applyAutomaticTransitions({ purgeArchivedAfterDays: 30 });
    expect(r.purged.map((p) => p.name)).toContain("old-arch");
    expect(loadArchived()).toHaveLength(0);
  });

  it("is idempotent — second run finds nothing", () => {
    createProtocol(mkProtocol("stale-once"));
    const usagePath = join(TEMP, "protocols", "usage.jsonl");
    const oldTs = Date.now() - 200 * DAY;
    appendFileSync(usagePath, JSON.stringify({ ts: oldTs, action: "invoked", name: "stale-once" }) + "\n");

    const r1 = applyAutomaticTransitions({ archiveAfterDays: 30 });
    expect(r1.archived.map((a) => a.name)).toContain("stale-once");
    const r2 = applyAutomaticTransitions({ archiveAfterDays: 30 });
    expect(r2.archived).toHaveLength(0);
  });
});

describe("smoke: full archive/unarchive/pin lifecycle", () => {
  it("end-to-end create → invoke → pin → archive → unarchive", () => {
    createProtocol(mkProtocol("lifecycle"));
    expect(loadCustomProtocols().map((p) => p.name)).toContain("lifecycle");

    // Pin it
    const pinned = editProtocol("lifecycle", { pinned: true });
    expect(pinned.pinned).toBe(true);

    // Unpin
    const unpinned = editProtocol("lifecycle", { pinned: false });
    expect(unpinned.pinned).toBe(false);

    // Archive
    const rec = archiveProtocol("lifecycle", "no longer needed");
    expect(rec).not.toBeNull();
    expect(loadCustomProtocols().map((p) => p.name)).not.toContain("lifecycle");
    expect(loadArchived().map((r) => r.protocol.name)).toContain("lifecycle");

    // Restore
    const r = unarchiveProtocol("lifecycle");
    expect(r.error).toBeUndefined();
    expect(loadCustomProtocols().map((p) => p.name)).toContain("lifecycle");
    expect(loadArchived()).toHaveLength(0);
  });
});
