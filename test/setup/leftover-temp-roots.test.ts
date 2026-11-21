// A test file's temp root that Windows still holds is deleted at the end of the run
// instead of failing the file; anything else still fails where it happens.

import { describe, it, expect } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LEFTOVERS_ENV, removeTestRoot, sweepLeftoverRoots, type RemoveDeps } from "./leftover-temp-roots.js";

function errno(code: string): NodeJS.ErrnoException {
  return Object.assign(new Error(`${code}: simulated`), { code });
}

function deps(over: Partial<RemoveDeps>): RemoveDeps & { recorded: string[] } {
  const recorded: string[] = [];
  return {
    platform: "win32",
    leftoversFile: "leftovers.txt",
    remove: async () => { throw errno("ENOTEMPTY"); },
    record: (_file, dir) => recorded.push(dir),
    ...over,
    recorded,
  };
}

describe("removeTestRoot", () => {
  it("hands a root Windows still holds to the end-of-run sweep instead of failing the file", async () => {
    // 2026-11-20: every test passed and main went red on this ENOTEMPTY alone.
    for (const code of ["ENOTEMPTY", "EBUSY", "EPERM"]) {
      const d = deps({ remove: async () => { throw errno(code); } });
      await expect(removeTestRoot("C:\\tmp\\lax-home-x", d)).resolves.toBeUndefined();
      expect(d.recorded).toEqual(["C:\\tmp\\lax-home-x"]);
    }
  });

  it("still fails outside Windows, where a folder that will not empty means something is writing into it", async () => {
    const d = deps({ platform: "linux" });
    await expect(removeTestRoot("/tmp/lax-home-x", d)).rejects.toThrow(/ENOTEMPTY/);
    expect(d.recorded).toEqual([]);
  });

  it("still fails on an error that is not a lock, or when no sweep is wired", async () => {
    await expect(removeTestRoot("x", deps({ remove: async () => { throw errno("EACCES"); } }))).rejects.toThrow(/EACCES/);
    await expect(removeTestRoot("x", deps({ leftoversFile: undefined }))).rejects.toThrow(/ENOTEMPTY/);
  });

  it("records nothing when the root deletes", async () => {
    const d = deps({ remove: async () => {} });
    await removeTestRoot("x", d);
    expect(d.recorded).toEqual([]);
  });
});

describe("sweepLeftoverRoots", () => {
  it("deletes each handed-over root once", async () => {
    const run = mkdtempSync(join(tmpdir(), "leftover-sweep-"));
    const stuck = join(run, "lax-home-a");
    mkdirSync(join(stuck, ".lax"), { recursive: true });
    writeFileSync(join(stuck, ".lax", "config.json"), "{}");
    const list = join(run, "leftover-roots.txt");
    writeFileSync(list, `${stuck}\n${stuck}\r\n`);
    const removed: string[] = [];
    await sweepLeftoverRoots(list, async (dir) => { removed.push(dir); });
    expect(removed).toEqual([stuck]);
    await sweepLeftoverRoots(list);
    expect(existsSync(stuck)).toBe(false);
  });

  it("fails the run naming every root that still will not go", async () => {
    const run = mkdtempSync(join(tmpdir(), "leftover-sweep-"));
    const list = join(run, "leftover-roots.txt");
    writeFileSync(list, "C:\\tmp\\lax-home-a\nC:\\tmp\\lax-home-b\n");
    await expect(sweepLeftoverRoots(list, async () => { throw errno("EBUSY"); })).rejects.toThrow(
      /lax-home-a \(EBUSY\)\nC:\\tmp\\lax-home-b \(EBUSY\)/,
    );
  });

  it("is a no-op when no root was handed over", async () => {
    await expect(sweepLeftoverRoots(join(tmpdir(), `no-leftovers-${Date.now()}.txt`))).resolves.toBeUndefined();
  });
});

describe("the sweep is wired into this run", () => {
  it("every test file knows where to hand a root over", () => {
    expect(process.env[LEFTOVERS_ENV]).toMatch(/lax-test-run-[^\\/]+[\\/]leftover-roots\.txt$/);
  });
});
