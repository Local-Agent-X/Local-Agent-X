/**
 * Regression lock for the build-ari cross-worktree write.
 *
 * scripts/build-ari.js used to resolve @arikernel/* through node_modules'
 * realpath. In a worktree whose node_modules is a symlink into the main
 * checkout, that realpath leads to the MAIN repo's packages/arikernel/* —
 * so a worktree `npm run build:ari` compiled the main repo's dist from the
 * worktree's invocation. The script must resolve package sources relative
 * to the repo it lives in (script location, not cwd, not node_modules).
 */
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const PACKAGES = ["core", "taint-tracker", "audit-log", "policy-engine", "tool-executors", "runtime"];
const roots: string[] = [];

afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })));

function scaffold() {
  const root = mkdtempSync(join(tmpdir(), "lax-build-ari-"));
  roots.push(root);

  // "Worktree": has the script and its own (empty) package sources.
  const repo = join(root, "worktree");
  mkdirSync(join(repo, "scripts"), { recursive: true });
  copyFileSync(resolve("scripts/build-ari.js"), join(repo, "scripts", "build-ari.js"));
  for (const pkg of PACKAGES) mkdirSync(join(repo, "packages", "arikernel", pkg), { recursive: true });

  // "Main repo": decoy package dirs WITH package.json — the old node_modules
  // realpath resolution would pick these and try to build into them.
  const decoy = join(root, "main");
  for (const pkg of PACKAGES) {
    const dir = join(decoy, "packages", "arikernel", pkg);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "package.json"), JSON.stringify({ name: `@arikernel/${pkg}` }));
  }

  // Worktree node_modules symlinked at the decoy, like a real worktree setup.
  mkdirSync(join(repo, "node_modules", "@arikernel"), { recursive: true });
  for (const pkg of PACKAGES) {
    symlinkSync(join(decoy, "packages", "arikernel", pkg), join(repo, "node_modules", "@arikernel", pkg), "dir");
  }

  return { repo, decoy };
}

describe("build-ari resolves package sources against its own repo root", () => {
  it("prefers the script repo's packages/ over node_modules' realpath, regardless of cwd", () => {
    const { repo, decoy } = scaffold();
    // cwd deliberately points at NEITHER repo — resolution must come from the
    // script's own location, not the working directory.
    const output = execFileSync(process.execPath, [join(repo, "scripts", "build-ari.js")], {
      cwd: tmpdir(), encoding: "utf8",
    });
    for (const pkg of PACKAGES) {
      // Local dirs exist but carry no package.json → the script must report
      // the WORKTREE path as the skip location. Seeing the decoy path here
      // means it followed node_modules into the other checkout again.
      expect(output).toContain(`skip ${pkg} (no package.json at ${join(repo, "packages", "arikernel", pkg)})`);
    }
    expect(output).not.toContain(decoy);
  });
});
