/**
 * CLASS INVARIANT: one eval run measures one build.
 *
 * The instance (2026-09-20): a `npm run build` landed 27 minutes into a
 * 37-minute op-outcomes run. The rig boots a fresh server per case straight
 * from dist/, so the first 43 cases measured the old build and the last 20
 * measured the new one. The run reported 18/63 and nothing flagged it, so a
 * number that described neither build was nearly used for a keep decision.
 *
 * The existing dist-vs-source guard could not see it: that rebuild re-stamped
 * the SAME commit, so git state was identical before and after. What changed
 * was the artifact, which is therefore what gets pinned.
 */
import { mkdtempSync, mkdirSync, writeFileSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect, beforeEach } from "vitest";

const { assertDistUnchangedDuringRun, resetDistPin } = await import("../eval/op-outcomes/isolated.mjs");

/** A repo root with a dist/ the way a build leaves one. */
function fakeRepo(builtRef: string, body: string): string {
  const root = mkdtempSync(join(tmpdir(), "lax-distpin-"));
  mkdirSync(join(root, "dist"), { recursive: true });
  writeFileSync(join(root, "dist", "index.js"), body);
  writeFileSync(join(root, "dist", ".builtref"), builtRef);
  return root;
}

/** A rebuild: same or different commit, but the artifact is rewritten. */
function rebuild(root: string, builtRef: string, body: string): void {
  writeFileSync(join(root, "dist", "index.js"), body);
  writeFileSync(join(root, "dist", ".builtref"), builtRef);
  const later = new Date(Date.now() + 60_000);
  utimesSync(join(root, "dist", "index.js"), later, later);
}

beforeEach(() => resetDistPin());

describe("a run cannot straddle two builds", () => {
  it("pins the build on the first server boot and accepts every later boot of the same one", () => {
    const root = fakeRepo("7355c670eed3", "console.log(1)");
    expect(() => assertDistUnchangedDuringRun(root)).not.toThrow();
    for (let i = 0; i < 5; i++) expect(() => assertDistUnchangedDuringRun(root)).not.toThrow();
  });

  it("refuses a boot after a mid-run rebuild, even at the SAME commit", () => {
    // Exactly the incident: HEAD had not moved when the build ran, so the
    // builtref was byte-identical either side of it.
    const root = fakeRepo("7355c670eed3", "console.log(1)");
    assertDistUnchangedDuringRun(root);
    rebuild(root, "7355c670eed3", "console.log(2) // rebuilt, same commit");
    expect(() => assertDistUnchangedDuringRun(root)).toThrow(/rebuilt mid-run/);
  });

  it("refuses a boot after a rebuild at a different commit", () => {
    const root = fakeRepo("7355c670eed3", "console.log(1)");
    assertDistUnchangedDuringRun(root);
    rebuild(root, "19c20abe0000", "console.log(2)");
    expect(() => assertDistUnchangedDuringRun(root)).toThrow(/rebuilt mid-run/);
  });

  it("says the earlier cases are no longer comparable, not just that something changed", () => {
    const root = fakeRepo("7355c670eed3", "a");
    assertDistUnchangedDuringRun(root);
    rebuild(root, "7355c670eed3", "b");
    try {
      assertDistUnchangedDuringRun(root);
      throw new Error("expected a throw");
    } catch (e) {
      const msg = (e as Error).message;
      expect(msg).toMatch(/not comparable/);
      expect(msg).toMatch(/start the run again/);
      expect(msg, "names both builds so the reader can tell what happened").toContain("7355c670");
    }
  });

  it("a fresh run re-pins, so the guard does not strand the next run", () => {
    const root = fakeRepo("7355c670eed3", "a");
    assertDistUnchangedDuringRun(root);
    rebuild(root, "19c20abe0000", "b");
    resetDistPin();
    expect(() => assertDistUnchangedDuringRun(root)).not.toThrow();
  });
});
