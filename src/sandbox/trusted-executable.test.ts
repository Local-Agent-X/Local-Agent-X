import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resolveTrustedExecutable } from "./trusted-executable.js";

// Writability is injected: on Windows chmod does not make a directory
// read-only, and the rule under test is the walk, not the OS.
describe("a cage binary is taken only from a place this user cannot write", () => {
  let root = "";
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  function layout(): { userBin: string; systemBin: string; pathEnv: string } {
    root = mkdtempSync(join(tmpdir(), "lax-trusted-exe-"));
    const userBin = join(root, "home", ".local", "bin");
    const systemBin = join(root, "usr", "bin");
    for (const dir of [userBin, systemBin]) {
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "bwrap"), "#!/bin/sh\necho RAN; echo NET-BLOCKED\n");
      chmodSync(join(dir, "bwrap"), 0o755);
    }
    return { userBin, systemBin, pathEnv: [userBin, systemBin].join(delimiter) };
  }

  it("skips a planted copy ahead on PATH and takes the system's", () => {
    const { userBin, systemBin, pathEnv } = layout();
    const writable = (p: string) => p.startsWith(join(root, "home"));
    const out = resolveTrustedExecutable("bwrap", pathEnv, { isRoot: false, isWritable: writable });
    expect(out.path?.toLowerCase()).toBe(join(systemBin, "bwrap").toLowerCase());
    expect(out.rejected).toEqual([join(userBin, "bwrap")]);
  });

  it("finds nothing when every copy is writable, naming each one", () => {
    const { userBin, systemBin, pathEnv } = layout();
    const out = resolveTrustedExecutable("bwrap", pathEnv, { isRoot: false, isWritable: () => true });
    expect(out.path).toBeNull();
    expect(out.rejected).toEqual([join(userBin, "bwrap"), join(systemBin, "bwrap")]);
  });

  it("as root, the first executable is the cage — root owns the machine either way", () => {
    const { userBin, pathEnv } = layout();
    const out = resolveTrustedExecutable("bwrap", pathEnv, { isRoot: true, isWritable: () => true });
    expect(out.path?.toLowerCase()).toBe(join(userBin, "bwrap").toLowerCase());
  });

  it("ignores relative PATH entries and names that are not files", () => {
    const { pathEnv } = layout();
    const out = resolveTrustedExecutable("bwrap", ["relative", "", pathEnv].join(delimiter), { isRoot: false, isWritable: () => false });
    expect(out.path).not.toBeNull();
    expect(resolveTrustedExecutable("no-such-tool", pathEnv, { isRoot: false, isWritable: () => false }).path).toBeNull();
  });
});
