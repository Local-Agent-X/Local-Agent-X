/**
 * Small JSON stores are replaced whole on every save. A plain writeFileSync
 * truncates the file first, so a crash mid-write, or a reader that opens it in
 * that instant, finds half a file: an app's state then reads as "App not
 * found", and a log or history starts over empty. These stores write through
 * atomicWriteFileSync (util/json-store.ts): a private temp file renamed over
 * the target, so a reader sees the whole old file or the whole new one.
 *
 * Two checks. The app runtime's files are followed onto disk: node:fs is
 * wrapped with pass-through recorders, and the final path must arrive by
 * rename, never by a direct write. The other stores are held by their source:
 * none may call writeFileSync at all.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const rec = vi.hoisted(() => ({
  writes: [] as string[],
  renames: [] as Array<{ src: string; dest: string }>,
}));

vi.mock("node:fs", async (importActual) => {
  const actual = await importActual<typeof import("node:fs")>();
  return {
    ...actual,
    writeFileSync: ((path: Parameters<typeof actual.writeFileSync>[0], ...rest: unknown[]) => {
      rec.writes.push(String(path));
      // @ts-expect-error — forward the exact args to the real impl.
      return actual.writeFileSync(path, ...rest);
    }) as typeof actual.writeFileSync,
    renameSync: ((src: Parameters<typeof actual.renameSync>[0], dest: Parameters<typeof actual.renameSync>[1]) => {
      rec.renames.push({ src: String(src), dest: String(dest) });
      return actual.renameSync(src, dest);
    }) as typeof actual.renameSync,
  };
});

import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { appDir, eventsPath, statePath } from "../src/app-runtime/paths.js";
import { readState, writeState } from "../src/app-runtime/state-store.js";
import { consumeEvents, pushEvent, readEvents } from "../src/app-runtime/events-store.js";
import type { AppState } from "../src/app-runtime/types.js";
import type { RateLimiter } from "../src/app-runtime/rate-limiter.js";
import { loadStored, storedPath, ensureDirs } from "../src/memory/cognitive/compression/persistence.js";

const APP = "atomic-writes-app";
const open = { check: () => true } as unknown as RateLimiter;
const state = (version: number): AppState => ({
  componentValues: { counter: version },
  actionQueue: [],
  metadata: { lastAgentUpdate: 1, lastUserUpdate: 0, version },
});

beforeEach(() => {
  mkdirSync(appDir(APP), { recursive: true });
  rec.writes.length = 0;
  rec.renames.length = 0;
});

afterEach(() => rmSync(appDir(APP), { recursive: true, force: true }));

describe("an app's state and events are replaced whole, never rewritten in place", () => {
  it("state.json arrives by rename", () => {
    writeState(APP, state(1));
    writeState(APP, state(2));
    expect(readState(APP)?.metadata.version).toBe(2);
    expect(rec.writes).not.toContain(statePath(APP));
    expect(rec.renames.filter((r) => r.dest === statePath(APP))).toHaveLength(2);
  });

  it("events.json arrives by rename on a push and on a consume", () => {
    writeState(APP, state(1));
    const pushed = pushEvent(APP, { type: "click", componentId: "b1", data: {} } as never, open).event!;
    consumeEvents(APP, [pushed.id]);
    expect(readEvents(APP)).toMatchObject([{ id: pushed.id, consumed: true }]);
    expect(rec.writes).not.toContain(eventsPath(APP));
    expect(rec.renames.filter((r) => r.dest === eventsPath(APP))).toHaveLength(2);
  });
});

describe("a stored compression that cannot be read", () => {
  it("is reported as missing, not thrown at the caller", () => {
    ensureDirs();
    const file = storedPath("atomic-writes-torn");
    writeFileSync(file, '{"id": "atomic-writes-torn", "levels": {"full": "half a fi', "utf-8");
    try {
      expect(loadStored("atomic-writes-torn")).toBeNull();
      expect(loadStored("atomic-writes-none")).toBeNull();
    } finally {
      rmSync(file, { force: true });
    }
  });
});

describe("stores that save a whole file", () => {
  it.each([
    "src/app-runtime/registry.ts",
    "src/app-runtime/state-store.ts",
    "src/app-runtime/events-store.ts",
    "src/app-runtime/audit.ts",
    "src/memory/cognitive/compression/persistence.ts",
    "src/memory/cognitive/consolidation/index.ts",
    "src/cognition/contradiction-detector.ts",
    "src/orchestrator/storage.ts",
    "src/orchestrator/state.ts",
    "src/session/router.ts",
    "src/sync/pull-files/pull-memory.ts",
  ])("%s writes through atomicWriteFileSync only", (file) => {
    const source = readFileSync(file, "utf-8");
    expect(source).toContain("atomicWriteFileSync");
    expect(source, "a plain writeFileSync truncates the file before it writes").not.toMatch(/\bwriteFileSync\b/);
    expect(source, "a hand-rolled rename has no retry when Windows holds the target").not.toMatch(/\brenameSync\(\s*tmp/);
  });
});
