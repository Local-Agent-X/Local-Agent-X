import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { UpdateRollbackTransaction } from "./update-rollback.js";

// Every path check is an lstatSync or realpathSync; the file I/O itself is
// async. Counting the two isolates what the checks cost from how fast the disk is.
const calls = vi.hoisted(() => ({ lstat: 0, realpath: 0 }));
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  const lstatSync = ((...args: Parameters<typeof actual.lstatSync>) => {
    calls.lstat++;
    return actual.lstatSync(...args);
  }) as typeof actual.lstatSync;
  const realpathSync = Object.assign((...args: Parameters<typeof actual.realpathSync>) => {
    calls.realpath++;
    return actual.realpathSync(...args);
  }, { native: actual.realpathSync.native }) as typeof actual.realpathSync;
  return { ...actual, default: { ...actual, lstatSync, realpathSync }, lstatSync, realpathSync };
});

const roots: string[] = [];
afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })));

type Counts = { lstat: number; realpath: number };

async function phaseCosts(files: number): Promise<{ begin: Counts; restore: Counts }> {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "lax-update-rollback-cost-")));
  roots.push(root);
  const install = join(root, "install");
  mkdirSync(join(install, "src", "deep", "er"), { recursive: true });
  const paths = Array.from({ length: files }, (_, index) => join("src", "deep", "er", `file-${index}.ts`));
  for (const path of paths) writeFileSync(join(install, path), path);
  const tx = new UpdateRollbackTransaction(join(root, "state"));
  const measure = async (phase: () => Promise<unknown>): Promise<Counts> => {
    const before = { ...calls };
    await phase();
    return { lstat: calls.lstat - before.lstat, realpath: calls.realpath - before.realpath };
  };

  const begin = await measure(() => tx.begin(install, "a".repeat(40), "b".repeat(40), paths));
  await tx.markApplied("b".repeat(40));
  for (const path of paths) writeFileSync(join(install, path), "updated");
  const restore = await measure(() => tx.restore(install, "b".repeat(40), "cost"));
  return { begin, restore };
}

describe("update rollback path-check cost", () => {
  it("spends a bounded number of path syscalls per file in each phase", async () => {
    // The marginal cost of one more file, so the fixed per-phase work cancels.
    // Each file used to cost ~129 realpathSync (every one a walk from the drive
    // root) and ~148 lstatSync per phase: ~25 ms a file on Windows, minutes for
    // a large update. The per-operation checks before each copy, digest and
    // removal stay; what went was re-resolving the same bases for every
    // component and every entry of every journal sweep.
    const small = await phaseCosts(4);
    const large = await phaseCosts(20);
    for (const phase of ["begin", "restore"] as const) {
      const realpathPerFile = (large[phase].realpath - small[phase].realpath) / 16;
      const lstatPerFile = (large[phase].lstat - small[phase].lstat) / 16;
      expect(realpathPerFile, `${phase} realpathSync per file`).toBeLessThanOrEqual(12);
      expect(lstatPerFile, `${phase} lstatSync per file`).toBeLessThanOrEqual(90);
    }
  });
});
