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
import { getAllProtocols } from "../src/protocols/index.js";
import { recordUsage } from "../src/protocols/usage.js";
import type { Protocol } from "../src/protocols/types.js";

const DAY = 86_400_000;

let TEMP: string;
let TEMP_LAX: string;
let ORIGINAL_CFG: LAXConfig;
let ORIGINAL_LAX_DATA_DIR: string | undefined;

beforeAll(() => {
  TEMP = mkdtempSync(join(tmpdir(), "lax-archive-test-"));
  ORIGINAL_CFG = getRuntimeConfig();
  setRuntimeConfig({ ...ORIGINAL_CFG, workspace: TEMP } as LAXConfig);

  // Pin the LAX data dir too. getAllProtocols() reaches the loader, which runs
  // the legacy migrations (~/.lax/skills, ~/.lax/protocols/imported) by
  // renameSync-ing their contents INTO the workspace — here a temp dir that
  // afterAll deletes. Unpinned, running this suite on a machine that still has
  // those legacy dirs would destroy the user's real imported protocols. Pinning
  // also makes the managed-learned tier deterministic instead of reading
  // whatever happens to be on the dev box.
  TEMP_LAX = mkdtempSync(join(tmpdir(), "lax-archive-test-laxdir-"));
  ORIGINAL_LAX_DATA_DIR = process.env.LAX_DATA_DIR;
  process.env.LAX_DATA_DIR = TEMP_LAX;
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
  if (ORIGINAL_LAX_DATA_DIR === undefined) delete process.env.LAX_DATA_DIR;
  else process.env.LAX_DATA_DIR = ORIGINAL_LAX_DATA_DIR;
  rmSync(TEMP, { recursive: true, force: true });
  rmSync(TEMP_LAX, { recursive: true, force: true });
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

describe("authorship provenance survives the archive round-trip", () => {
  // Why this is pinned: agent-authored protocols are written with no user
  // confirmation gate, so "archive it" IS the user's undo — and the undo is
  // only usable if the user can still tell agent work from their own after a
  // restore. Provenance is therefore load-bearing for the recovery story, not
  // decoration. Every hop below is a place a refactor could plausibly rebuild
  // the source object (loader stamping, JSON round-trips, the archive
  // hand-off); toEqual on the whole object fails on a dropped OR an invented
  // field, so any reconstruction anywhere on the path breaks this test.
  const PROV = {
    type: "custom" as const,
    authoredBy: "agent" as const,
    authoredAt: 1_700_000_000_123,
    authoredFromSession: "sess-round-trip",
  };

  it("preserves authoredBy/authoredAt/authoredFromSession from create through unarchive", () => {
    createProtocol(mkProtocol("prov-lifecycle", { source: { ...PROV } }));

    // 1. Persisted to custom.json — assert the bytes on disk, not just the
    //    in-memory object we handed in.
    const liveRaw = JSON.parse(
      readFileSync(join(TEMP, "protocols", "custom.json"), "utf-8"),
    ) as Protocol[];
    expect(liveRaw.find((p) => p.name === "prov-lifecycle")?.source).toEqual(PROV);

    // 2. Survives the real read path (stampCustomSource must not clobber an
    //    existing source; mergeByName must not rebuild the record).
    const loaded = getAllProtocols().find((p) => p.name === "prov-lifecycle");
    expect(loaded?.source).toEqual(PROV);

    // 3. Survives the move into archived.json.
    const rec = archiveProtocol("prov-lifecycle", "user rejected agent's work");
    expect(rec!.protocol.source).toEqual(PROV);
    const archRaw = JSON.parse(
      readFileSync(join(TEMP, "protocols", "archived.json"), "utf-8"),
    ) as Array<{ protocol: Protocol }>;
    expect(archRaw.find((r) => r.protocol.name === "prov-lifecycle")?.protocol.source).toEqual(PROV);

    // 4. Survives the restore back into custom.json — the recovery story.
    const restored = unarchiveProtocol("prov-lifecycle");
    expect(restored.error).toBeUndefined();
    expect(restored.restored?.source).toEqual(PROV);
    expect(loadCustomProtocols().find((p) => p.name === "prov-lifecycle")?.source).toEqual(PROV);
    const backRaw = JSON.parse(
      readFileSync(join(TEMP, "protocols", "custom.json"), "utf-8"),
    ) as Protocol[];
    expect(backRaw.find((p) => p.name === "prov-lifecycle")?.source).toEqual(PROV);

    // 5. Still distinguishable as agent work after the full trip.
    expect(getAllProtocols().find((p) => p.name === "prov-lifecycle")?.source?.authoredBy).toBe("agent");
  });

  it("reads a protocol with no source as unknown authorship, never as user-authored", () => {
    // Every protocol written before provenance existed has no `source` at all.
    // The loader stamps type="custom" but must leave authorship blank —
    // three-state (agent / user / unknown). A consumer that treats
    // `authoredBy !== "agent"` as "user" would mislabel the entire legacy
    // catalog as user-authored and hide it from an agent-work review.
    createProtocol(mkProtocol("prov-legacy"));

    const loaded = getAllProtocols().find((p) => p.name === "prov-legacy");
    expect(loaded).toBeDefined();
    expect(loaded?.source?.type).toBe("custom");
    expect(loaded?.source?.authoredBy).toBeUndefined();
    expect(loaded?.source?.authoredBy).not.toBe("user");

    // Absence must also survive the round trip — an archive/restore cycle must
    // not invent authorship that was never recorded.
    archiveProtocol("prov-legacy");
    const restored = unarchiveProtocol("prov-legacy");
    expect(restored.restored?.source?.authoredBy).toBeUndefined();
  });
});
