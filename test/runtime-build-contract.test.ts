// An installed copy of LAX is unpacked from a source archive and has no .git.
// The installer and the desktop updater compile it on the user's machine; when
// they ran the full `npm run build`, its developer checks ran too, and the one
// that lists files through git aborted every fresh install and update build
// (2026-10-23). They run `build:runtime`, the compile alone; CI runs the checks
// on every commit before it is offered.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (p: string) => readFileSync(join(root, p), "utf8");
const scripts = (JSON.parse(read("package.json")) as { scripts: Record<string, string> }).scripts;

describe("the build a user's machine runs", () => {
  it("build:runtime compiles and checks nothing", () => {
    const steps = scripts["build:runtime"]!.split("&&").map((s) => s.trim());
    expect(steps).toContain("tsc");
    expect(steps).toContain("npm run build:ari");
    expect(steps.filter((s) => s.includes("check:"))).toEqual([]);
  });

  it("build is the developer checks, then build:runtime", () => {
    const steps = scripts.build!.split("&&").map((s) => s.trim());
    expect(steps[steps.length - 1]).toBe("npm run build:runtime");
    expect(steps.slice(0, -1).every((s) => s.startsWith("npm run check:"))).toBe(true);
  });

  it("the installer and the desktop updater run build:runtime, never build", () => {
    for (const file of ["scripts/installer/core-steps.mjs", "desktop/src/reconcile.ts"]) {
      const src = read(file);
      expect(src, file).toContain('["run", "build:runtime"]');
      expect(src, file).not.toContain('["run", "build"]');
    }
  });
});
