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
import { catalogReadFailureCount } from "../src/protocols/loader.js";
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

  it("archives a re-created name ALONGSIDE the old record instead of destroying it", () => {
    // The data-loss case. `createProtocol` only rejects collisions against the
    // LIVE catalog, so an archived name is instantly re-creatable — and the
    // archive used to hold one record per name, so the second archive of a name
    // "resolved" the clash by hard-removing the live copy without archiving it.
    // Whatever the second version said was then gone, and the call returned null
    // so every caller reported "already archived".
    createProtocol(mkProtocol("notes", { description: "VERSION ONE" }));
    expect(archiveProtocol("notes")).not.toBeNull();
    createProtocol(mkProtocol("notes", { description: "VERSION TWO" }));

    const rec = archiveProtocol("notes");
    expect(rec).not.toBeNull();
    expect(rec!.protocol.description).toBe("VERSION TWO");

    const descriptions = loadArchived()
      .filter((r) => r.protocol.name === "notes")
      .map((r) => r.protocol.description)
      .sort();
    expect(descriptions).toEqual(["VERSION ONE", "VERSION TWO"]);
    expect(loadCustomProtocols().map((p) => p.name)).not.toContain("notes");
  });

  it("gives each version of a name a distinct archivedTs", () => {
    // archivedTs is how a caller names the version it wants back, so two
    // archives landing in the same millisecond must not produce one ambiguous
    // key. Programmatic archive → create → archive is sub-millisecond.
    createProtocol(mkProtocol("samems", { description: "one" }));
    const a = archiveProtocol("samems")!;
    createProtocol(mkProtocol("samems", { description: "two" }));
    const b = archiveProtocol("samems")!;
    expect(b.archivedTs).not.toBe(a.archivedTs);
    expect(b.archivedTs).toBeGreaterThan(a.archivedTs);
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

  it("restores the NEWEST version when several are archived", () => {
    createProtocol(mkProtocol("multi", { description: "v1" }));
    archiveProtocol("multi");
    createProtocol(mkProtocol("multi", { description: "v2" }));
    archiveProtocol("multi");

    const r = unarchiveProtocol("multi");
    expect(r.restored?.description).toBe("v2");
    // The older version is still in the archive — restoring one doesn't consume
    // the rest.
    expect(loadArchived().filter((x) => x.protocol.name === "multi")).toHaveLength(1);
    expect(loadArchived()[0].protocol.description).toBe("v1");
  });

  it("restores a specific older version when given its archivedTs", () => {
    createProtocol(mkProtocol("pinpoint", { description: "v1" }));
    const first = archiveProtocol("pinpoint")!;
    createProtocol(mkProtocol("pinpoint", { description: "v2" }));
    archiveProtocol("pinpoint");

    const r = unarchiveProtocol("pinpoint", { archivedTs: first.archivedTs });
    expect(r.error).toBeUndefined();
    expect(r.restored?.description).toBe("v1");
    expect(loadArchived().map((x) => x.protocol.description)).toEqual(["v2"]);
  });

  it("errors on an archivedTs that doesn't exist rather than restoring something else", () => {
    createProtocol(mkProtocol("stamped"));
    archiveProtocol("stamped");
    const r = unarchiveProtocol("stamped", { archivedTs: 1 });
    expect(r.restored).toBeUndefined();
    expect(r.error).toMatch(/no archived version stamped/);
    expect(loadArchived()).toHaveLength(1);
  });
});

describe("version order is insertion order, not clock order", () => {
  // archived.json is append-only, so the array itself records which version was
  // archived after which. archivedTs cannot: the clock can step backwards, and
  // records written before stamps existed have none at all. Both cases below
  // hand a restore the WRONG CONTENT if ordering is read off the timestamp.

  it("restores the last-archived version even when the clock stepped backwards", () => {
    createProtocol(mkProtocol("clockskew", { description: "VERSION ONE" }));
    archiveProtocol("clockskew");

    // NTP correction / VM resume / DST-adjacent tooling between the two
    // archives: the second archive is stamped BEFORE the first.
    const path = join(TEMP, "protocols", "archived.json");
    const arr = JSON.parse(readFileSync(path, "utf-8")) as Array<{ archivedTs: number }>;
    arr[0].archivedTs = Date.now() + 1_000_000;
    writeFileSync(path, JSON.stringify(arr));

    createProtocol(mkProtocol("clockskew", { description: "VERSION TWO" }));
    archiveProtocol("clockskew");

    expect(unarchiveProtocol("clockskew").restored?.description).toBe("VERSION TWO");
  });

  it("purges the first-archived version even when the clock stepped backwards", () => {
    createProtocol(mkProtocol("skewpurge", { description: "VERSION ONE" }));
    archiveProtocol("skewpurge");
    const path = join(TEMP, "protocols", "archived.json");
    const arr = JSON.parse(readFileSync(path, "utf-8")) as Array<{ archivedTs: number }>;
    arr[0].archivedTs = Date.now() + 1_000_000;
    writeFileSync(path, JSON.stringify(arr));
    createProtocol(mkProtocol("skewpurge", { description: "VERSION TWO" }));
    archiveProtocol("skewpurge");

    expect(purgeArchivedProtocol("skewpurge")).toBe(true);
    expect(loadArchived().map((r) => r.protocol.description)).toEqual(["VERSION TWO"]);
  });

  it("a record with no archivedTs does not make the current version unreachable", () => {
    // Every record written before stamps existed has none. `n >= undefined` is
    // false, so a max-by-timestamp scan pins the stamp-less record as "newest"
    // forever and the version the user actually wants can never be restored.
    const path = join(TEMP, "protocols", "archived.json");
    writeFileSync(path, JSON.stringify([
      { protocol: mkProtocol("legacy", { description: "PRE-STAMP" }) },
    ]));

    createProtocol(mkProtocol("legacy", { description: "CURRENT" }));
    archiveProtocol("legacy");

    expect(unarchiveProtocol("legacy").restored?.description).toBe("CURRENT");
    expect(loadArchived()).toHaveLength(1);
  });

  it("never purges a record it cannot date", () => {
    // `null` is the dangerous one, not `undefined`: `Date.now() - null` is
    // Date.now(), so an unstamped record reads as archived at the epoch and the
    // 30-day purge deletes it on the very first sweep. (`undefined` yields NaN,
    // which compares false and happens to be safe — but only by accident.)
    const path = join(TEMP, "protocols", "archived.json");
    writeFileSync(path, JSON.stringify([
      { archivedTs: null, protocol: mkProtocol("nulled", { description: "PRE-STAMP" }) },
      { protocol: mkProtocol("undated", { description: "ALSO PRE-STAMP" }) },
    ]));
    const r = applyAutomaticTransitions({ purgeArchivedAfterDays: 1 });
    expect(r.purged).toHaveLength(0);
    expect(loadArchived().map((x) => x.protocol.name)).toEqual(["nulled", "undated"]);
  });
});

describe("an unreadable archive is never written over", () => {
  // archived.json is git-synced and now holds every version of every name, so a
  // merge-conflict blob here is the most destructive degraded read in the
  // subsystem: it degrades to [], and the next write replaces the whole file
  // with a one-element array. custom.json got this guard; the archive didn't.
  const CONFLICT = '<<<<<<< HEAD\n[{"archivedTs":1}]\n=======\n[{"archivedTs":2}]\n>>>>>>> origin/main\n';
  const archPath = () => join(TEMP, "protocols", "archived.json");

  it("archiveProtocol refuses instead of replacing the file", () => {
    createProtocol(mkProtocol("wontclobber"));
    writeFileSync(archPath(), CONFLICT, "utf-8");

    // Counted like every other degraded catalog read, so a destructive
    // reconciler bracketing its own read can tell the state was partial.
    const before = catalogReadFailureCount();
    expect(() => archiveProtocol("wontclobber")).toThrow(/could not be read/);
    expect(catalogReadFailureCount()).toBeGreaterThan(before);
    // Both sides survive: the archive file is byte-identical and the live copy
    // was not removed.
    expect(readFileSync(archPath(), "utf-8")).toBe(CONFLICT);
    expect(loadCustomProtocols().map((p) => p.name)).toContain("wontclobber");
  });

  it("treats a parseable non-array the same as a corrupt one", () => {
    // `{"nope":1}` parses cleanly, so the JSON catch never fires — the exact
    // hole that existed for custom.json. Without the shape check this reads as
    // an empty archive and the next write replaces the file.
    createProtocol(mkProtocol("shape-guard"));
    writeFileSync(archPath(), '{"nope":1}', "utf-8");

    const before = catalogReadFailureCount();
    expect(() => archiveProtocol("shape-guard")).toThrow(/could not be read/);
    expect(catalogReadFailureCount()).toBeGreaterThan(before);
    expect(readFileSync(archPath(), "utf-8")).toBe('{"nope":1}');
    expect(loadCustomProtocols().map((p) => p.name)).toContain("shape-guard");
  });

  it("purge writes nothing and unarchive reports the real reason", () => {
    writeFileSync(archPath(), CONFLICT, "utf-8");
    expect(purgeArchivedProtocol("anything")).toBe(false);
    expect(unarchiveProtocol("anything").error).toMatch(/could not be read/);
    expect(readFileSync(archPath(), "utf-8")).toBe(CONFLICT);
  });

  it("the unattended sweep does nothing at all", () => {
    createProtocol(mkProtocol("sweep-me"));
    const usagePath = join(TEMP, "protocols", "usage.jsonl");
    appendFileSync(usagePath, JSON.stringify({ ts: Date.now() - 200 * DAY, action: "invoked", name: "sweep-me" }) + "\n");
    writeFileSync(archPath(), CONFLICT, "utf-8");

    const r = applyAutomaticTransitions({ archiveAfterDays: 30, purgeArchivedAfterDays: 1 });
    expect(r.archived).toHaveLength(0);
    expect(r.purged).toHaveLength(0);
    expect(readFileSync(archPath(), "utf-8")).toBe(CONFLICT);
    expect(loadCustomProtocols().map((p) => p.name)).toContain("sweep-me");
  });
});

describe("malformed records don't take down the sweep", () => {
  it("skips a null protocol in custom.json and a stamp-less archive record", () => {
    // Both files are hand-editable and git-synced. `[null]` parses as an array,
    // so the shape guard passes it through, and the sweep runs unattended —
    // throwing there strands every other protocol's transition.
    saveCustomProtocols([null as unknown as Protocol, mkProtocol("real-one")]);
    writeFileSync(
      join(TEMP, "protocols", "archived.json"),
      JSON.stringify([{ archivedTs: Date.now() - 90 * DAY }]),
      "utf-8",
    );
    expect(() => applyAutomaticTransitions()).not.toThrow();
  });
});

describe("the split state has a non-destructive exit (F25)", () => {
  it("archives the live copy, restores it, and still leaves the older version recoverable", () => {
    // Reachable on the ordinary path: archive X, then create X again. Before
    // versioning, this state had no way out that kept both copies — archive
    // destroyed the live one, unarchive refused, and permanent-delete erased the
    // very copy the user was trying to keep.
    createProtocol(mkProtocol("split", { description: "VERSION ONE" }));
    const v1 = archiveProtocol("split")!;
    createProtocol(mkProtocol("split", { description: "VERSION TWO" }));

    // Step 1: get out of the split state without losing anything.
    expect(archiveProtocol("split")).not.toBeNull();
    expect(loadCustomProtocols().map((p) => p.name)).not.toContain("split");
    expect(loadArchived().filter((r) => r.protocol.name === "split")).toHaveLength(2);

    // Step 2: the live copy comes back by default.
    expect(unarchiveProtocol("split").restored?.description).toBe("VERSION TWO");

    // Step 3: and the older one is still reachable — archive the live copy
    // again (non-destructive), then restore the version you actually wanted.
    expect(archiveProtocol("split")).not.toBeNull();
    const back = unarchiveProtocol("split", { archivedTs: v1.archivedTs });
    expect(back.error).toBeUndefined();
    expect(back.restored?.description).toBe("VERSION ONE");
    expect(loadCustomProtocols().find((p) => p.name === "split")?.description).toBe("VERSION ONE");
    expect(loadArchived().map((r) => r.protocol.description)).toEqual(["VERSION TWO"]);
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

  it("removes the OLDEST version only, leaving newer ones archived", () => {
    // The age-based purge walks records, not names. If purging by name took
    // every version, one 31-day-old record would drag a fresh one out with it.
    createProtocol(mkProtocol("aging", { description: "v1" }));
    archiveProtocol("aging");
    createProtocol(mkProtocol("aging", { description: "v2" }));
    archiveProtocol("aging");

    expect(purgeArchivedProtocol("aging")).toBe(true);
    expect(loadArchived().map((r) => r.protocol.description)).toEqual(["v2"]);
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
