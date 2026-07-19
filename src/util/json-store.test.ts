import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { atomicWriteFileSync, createJsonStore } from "./json-store.js";

interface Demo extends Record<string, unknown> {
  records: number[];
  label: string | null;
  count: number;
  cache: Record<string, string>;
}

const demoDefaults = (): Demo => ({ records: [], label: null, count: 0, cache: {} });

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "json-store-"));
});
afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("load", () => {
  it("returns defaults when the file is missing", () => {
    const store = createJsonStore(join(dir, "missing.json"), { defaults: demoDefaults });
    expect(store.load()).toEqual(demoDefaults());
  });

  it("returns a fresh defaults object per load (no shared mutable state)", () => {
    const store = createJsonStore(join(dir, "missing.json"), { defaults: demoDefaults });
    const a = store.load();
    a.records.push(99);
    expect(store.load().records).toEqual([]);
  });

  it("returns defaults on corrupt JSON", () => {
    const file = join(dir, "corrupt.json");
    writeFileSync(file, "{ not json ", "utf-8");
    const store = createJsonStore(file, { defaults: demoDefaults });
    expect(store.load()).toEqual(demoDefaults());
  });

  it("falls back per key when a field has the wrong shape, drops unknown keys", () => {
    const file = join(dir, "shapes.json");
    writeFileSync(
      file,
      JSON.stringify({ records: "nope", label: "hi", count: 7, cache: [1], stray: true }),
      "utf-8",
    );
    const store = createJsonStore(file, { defaults: demoDefaults });
    const loaded = store.load();
    expect(loaded).toEqual({ records: [], label: "hi", count: 7, cache: {} });
    expect("stray" in loaded).toBe(false);
  });

  it("runs the upgrade hook on legacy shapes before merging", () => {
    const file = join(dir, "legacy.json");
    writeFileSync(file, JSON.stringify([1, 2, 3]), "utf-8");
    const store = createJsonStore(file, {
      defaults: demoDefaults,
      upgrade: (parsed) => (Array.isArray(parsed) ? { records: parsed } : parsed),
    });
    expect(store.load().records).toEqual([1, 2, 3]);
  });
});

describe("save", () => {
  it("round-trips and creates missing parent directories", () => {
    const file = join(dir, "nested", "deeper", "store.json");
    const store = createJsonStore(file, { defaults: demoDefaults });
    store.save({ records: [1, 2], label: "x", count: 3, cache: { a: "b" } });
    expect(store.load()).toEqual({ records: [1, 2], label: "x", count: 3, cache: { a: "b" } });
    expect(JSON.parse(readFileSync(file, "utf-8")).count).toBe(3);
  });

  it("caps arrays: bare number keeps the tail, head spec keeps the front — in place", () => {
    const file = join(dir, "caps.json");
    const store = createJsonStore<Demo>(file, {
      defaults: demoDefaults,
      caps: { records: 3 },
    });
    const value = { ...demoDefaults(), records: [1, 2, 3, 4, 5] };
    store.save(value);
    expect(value.records).toEqual([3, 4, 5]); // caller's object capped too
    expect(store.load().records).toEqual([3, 4, 5]);

    const headStore = createJsonStore<Demo>(join(dir, "caps-head.json"), {
      defaults: demoDefaults,
      caps: { records: { max: 2, keep: "head" } },
    });
    headStore.save({ ...demoDefaults(), records: [9, 8, 7] });
    expect(headStore.load().records).toEqual([9, 8]);
  });
});

describe("mutate", () => {
  it("loads, applies the mutation, saves, and returns the callback result", () => {
    const file = join(dir, "mutate.json");
    const store = createJsonStore(file, { defaults: demoDefaults });
    const result = store.mutate((draft) => {
      draft.records.push(42);
      draft.count += 1;
      return draft.count;
    });
    expect(result).toBe(1);
    expect(store.load()).toEqual({ records: [42], label: null, count: 1, cache: {} });
  });
});

describe("atomicity", () => {
  it("retries transient destination contention without rewriting the temp file", () => {
    const target = join(dir, "contended.json");
    const waits: number[] = [];
    let writes = 0;
    let renames = 0;

    atomicWriteFileSync(target, '{"complete":true}', undefined, {
      write(temp, data, opts) {
        writes += 1;
        writeFileSync(temp, data, opts);
      },
      rename(source, destination) {
        renames += 1;
        if (renames < 3) throw Object.assign(new Error("destination busy"), { code: "EPERM" });
        renameSync(source, destination);
      },
      unlink: rmSync,
      wait(ms) { waits.push(ms); },
    });

    expect(JSON.parse(readFileSync(target, "utf-8"))).toEqual({ complete: true });
    expect({ writes, renames, waits }).toEqual({ writes: 1, renames: 3, waits: [2, 4] });
  });

  it("bounds destination-contention retries and cleans the private temp", () => {
    const target = join(dir, "persistently-busy.json");
    writeFileSync(target, "original", "utf8");
    const waits: number[] = [];
    let renames = 0;

    expect(() => atomicWriteFileSync(target, "replacement", undefined, {
      write: writeFileSync,
      rename() {
        renames += 1;
        throw Object.assign(new Error("still busy"), { code: "EBUSY" });
      },
      unlink: rmSync,
      wait(ms) { waits.push(ms); },
    })).toThrow("still busy");

    expect(readFileSync(target, "utf8")).toBe("original");
    expect({ renames, waits }).toEqual({ renames: 7, waits: [2, 4, 8, 16, 32, 64] });
    expect(readdirSync(dir).filter(name => name.includes(".tmp."))).toEqual([]);
  });

  it("a failed write throws, leaves the target untouched, and litters no tmp files", () => {
    // Force the rename to fail: the target path is an existing non-empty
    // directory (fails on POSIX and Windows alike).
    const target = join(dir, "blocked.json");
    mkdirSync(target);
    writeFileSync(join(target, "occupant"), "keep me", "utf-8");

    expect(() => atomicWriteFileSync(target, '{"partial":true}')).toThrow();
    // Target untouched, tmp cleaned up.
    expect(readFileSync(join(target, "occupant"), "utf-8")).toBe("keep me");
    expect(readdirSync(dir).filter((n) => n.includes(".tmp."))).toEqual([]);
  });

  it("a save that throws before writing leaves the previous file intact", () => {
    const file = join(dir, "intact.json");
    const store = createJsonStore(file, { defaults: demoDefaults });
    store.save({ ...demoDefaults(), count: 5 });

    // JSON.stringify throws on BigInt — save() must rethrow without clobbering.
    const poisoned = { ...demoDefaults(), count: 5, cache: { big: 1n as unknown as string } };
    expect(() => store.save(poisoned as Demo)).toThrow();
    expect(store.load().count).toBe(5);
    expect(existsSync(file)).toBe(true);
    expect(readdirSync(dir).filter((n) => n.includes(".tmp."))).toEqual([]);
  });
});
