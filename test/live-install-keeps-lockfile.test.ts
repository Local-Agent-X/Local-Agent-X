// Every npm install the app runs on a live install leaves the committed
// lockfile as it is (--no-save). A plain install under another npm major
// rewrites it (npm 10 drops the "libc" fields npm 11 records), and a git
// install whose tracked lockfile changed refuses every update as "local
// changes" (2026-11-19: a machine on npm 10 rewrote it at every launch).
import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

/** Where the app installs into the live tree: startup reconcile, the update's live install, the installer. */
const SCANNED_DIRS = [["desktop", "src"], ["src"], ["scripts", "installer"]];

function sources(): Array<{ file: string; text: string }> {
  return SCANNED_DIRS.flatMap((parts) => {
    const dir = join(root, ...parts);
    return readdirSync(dir)
      .filter((name) => /\.(ts|mjs)$/.test(name) && !name.includes(".test."))
      .map((name) => ({ file: join(...parts, name), text: readFileSync(join(dir, name), "utf8") }));
  });
}

// An npm install's argument list: after `"npm",`, as runNpmAt's arguments, or
// the reconcile constant. brew/winget "install" lists are not npm's.
const NPM_INSTALL_ARGS = /(?:"npm",\s*|runNpmAt\([^,()]+,\s*|NPM_INSTALL_ARGS\s*=\s*)\[\s*"install"[^\]]*\]/g;

describe("live installs never write the lockfile", () => {
  const found = sources().flatMap(({ file, text }) => [...text.matchAll(NPM_INSTALL_ARGS)].map((m) => ({ file, args: m[0] })));

  it("finds the install call sites (the scan is not empty)", () => {
    const files = new Set(found.map((f) => f.file.replace(/\\/g, "/")));
    expect(files).toContain("desktop/src/reconcile.ts");
    expect(files).toContain("src/update-live-deps.ts");
    expect(files).toContain("scripts/installer/core-steps.mjs");
  });

  it("passes --no-save to every one", () => {
    const writers = found.filter((f) => !f.args.includes('"--no-save"')).map((f) => `${f.file}: ${f.args.replace(/\s+/g, " ")}`);
    expect(writers).toEqual([]);
  });
});
