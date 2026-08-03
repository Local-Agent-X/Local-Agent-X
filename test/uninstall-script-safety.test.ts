import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

// The uninstaller deletes directories, unattended, on a user's machine. These
// are the invariants that keep that from going wrong - each one corresponds to
// a way this could destroy something it must not, or fail to run at all.

// fileURLToPath, never url.pathname: this repo is routinely checked out to a
// path containing a space, which pathname leaves encoded as %20.
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel: string) => readFileSync(join(repoRoot, rel), "utf-8");

const PS1 = "scripts/uninstall/lax-uninstall.ps1";
const SH = "scripts/uninstall/lax-uninstall.sh";
const NSH = "desktop/build/installer.nsh";

describe("uninstaller safety invariants", () => {
  it("ships both uninstallers in git, or the rescue path does not exist for users", () => {
    const tracked = execFileSync("git", ["ls-files", "scripts/uninstall"], { cwd: repoRoot, encoding: "utf-8" })
      .split("\n").map(s => s.trim()).filter(Boolean);
    expect(tracked).toContain(PS1);
    expect(tracked).toContain(SH);
  });

  it("refuses to delete a git checkout on both platforms", () => {
    // A projectRoot pointing at a developer's clone must survive uninstall -
    // it is a working copy that may hold uncommitted work, not an artifact.
    expect(read(PS1)).toMatch(/Join-Path \$full '\.git'/);
    expect(read(SH)).toMatch(/-d "\$p\/\.git"/);
  });

  it("verifies a directory is ours before deleting it", () => {
    // Guards against a mis-set or hand-edited projectRoot turning the
    // uninstaller into a generic directory shredder.
    expect(read(PS1)).toContain("Test-LaxSourceTree");
    expect(read(SH)).toContain("is_lax_source_tree");
  });

  it("keeps user data unless deletion is explicitly requested", () => {
    expect(read(PS1)).toMatch(/\$DeleteData/);
    expect(read(SH)).toMatch(/DELETE_DATA=0/);
    // Default is 0/false: the destructive branch has to be opted into.
    expect(read(SH)).toMatch(/--delete-data\) DELETE_DATA=1/);
  });

  it("supports a preview mode, so users can see the plan before committing", () => {
    expect(read(PS1)).toMatch(/\$DryRun/);
    expect(read(SH)).toMatch(/--dry-run\)\s+DRY_RUN=1/);
  });

  it("cannot recurse with the packaged uninstaller", () => {
    // The NSIS hook calls this script; without the guard this script would
    // call the NSIS uninstaller straight back and the two would loop.
    const ps1 = read(PS1);
    expect(ps1).toContain("$SkipVendorUninstaller");
    expect(ps1).toContain("LAX_UNINSTALL_ACTIVE");
    expect(read(NSH)).toContain("-SkipVendorUninstaller");
  });

  it("removes every matching registry entry, not just the first", () => {
    // The two-rows-in-Settings bug: cleaning one key left the other behind.
    const ps1 = read(PS1);
    expect(ps1).toContain("Get-LaxRegistryEntries");
    expect(ps1).toMatch(/foreach \(\$e in Get-LaxRegistryEntries\)/);
  });

  it("stays ASCII-only so PowerShell 5.1 and bash cannot mis-decode it", () => {
    for (const file of [PS1, SH, NSH]) {
      const nonAscii = readFileSync(join(repoRoot, file)).filter(b => b > 127);
      expect(nonAscii.length, `${file} has non-ASCII bytes; PS 5.1 reads BOM-less .ps1 as ANSI`).toBe(0);
    }
  });
});

describe("NSIS uninstall hook", () => {
  it("is wired into the packaged build", () => {
    const pkg = JSON.parse(read("desktop/package.json"));
    expect(pkg.build.nsis.include).toBe("build/installer.nsh");
  });

  it("skips the deep clean during an in-place update", () => {
    // electron-builder runs the uninstaller as part of an update. Without this
    // gate, every update would delete the source tree the app runs from and
    // brick the install it was about to refresh.
    const nsh = read(NSH);
    expect(nsh).toMatch(/\$\{ifNot\}\s+\$\{isUpdated\}/);
    const gateAt = nsh.search(/\$\{ifNot\}\s+\$\{isUpdated\}/);
    // Anchor on the actual invocation, not the filename - it is mentioned in
    // the header comment too, which sits above the gate.
    const cleanupAt = nsh.indexOf("nsExec::ExecToLog");
    const destructiveAt = nsh.indexOf("RMDir /r");
    expect(gateAt).toBeGreaterThanOrEqual(0);
    expect(cleanupAt).toBeGreaterThan(gateAt);
    expect(destructiveAt).toBeGreaterThan(gateAt);
  });

  it("never deletes user data from a silent uninstall", () => {
    // A oneClick uninstaller runs without prompts. Destroying ~/.lax there
    // would take chats, memory and saved API keys with no confirmation.
    const nsh = read(NSH);
    expect(nsh).toContain("-Yes");
    expect(nsh).not.toContain("-DeleteData");
  });

  it("falls back to known paths when no staged uninstaller is present", () => {
    // Installs predating the staged uninstaller must still uninstall cleanly.
    const nsh = read(NSH);
    expect(nsh).toContain("lax_no_script");
    expect(nsh).toContain("DeleteRegKey HKCU");
  });
});
