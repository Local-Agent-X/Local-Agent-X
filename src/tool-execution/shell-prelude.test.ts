/**
 * The prelude a disk check steps past: commands that only look, then one
 * plain `cd`. Everything that could write, rename, run a program or change
 * which `rm` runs ends it.
 */
import { describe, expect, it } from "vitest";
import { resolve } from "node:path";
import { enterLeadingCd, enterPrelude, skipInertPrefix } from "./shell-prelude.js";

describe("skipInertPrefix", () => {
  it("steps past lookups, prints, set and mkdir", () => {
    expect(skipInertPrefix("command -v uv; set -e; mkdir -p out && rm -f a")).toBe("rm -f a");
    expect(skipInertPrefix("which node || echo missing\nrm -f a")).toBe("rm -f a");
    expect(skipInertPrefix("[ -d out ] && ls out; rm -f a")).toBe("rm -f a");
  });

  it("stops at anything that is not provably inert", () => {
    for (const command of [
      "echo x > a; rm -f a",
      "export PATH=/x:$PATH; rm -f a",
      "PATH=/x rm -f a",
      "command cp users.csv a; rm -f a",
      "ls $(mv users.csv a); rm -f a",
      "echo `mv users.csv a`; rm -f a",
      "echo 'a; b'; rm -f a",
      "command -v uv | rm -f a",
    ]) expect(skipInertPrefix(command), command).toBe(command);
  });
});

describe("enterLeadingCd", () => {
  const cwd = resolve("/work/proj");
  it("places an absolute or ./ ../ folder from a known cwd", () => {
    expect(enterLeadingCd("cd ../x && rm -f a", cwd)).toEqual({ command: "rm -f a", cwd: resolve(cwd, "../x") });
    expect(enterLeadingCd("rm -f a", cwd)).toEqual({ command: "rm -f a", cwd });
  });

  it("from an unknown cwd, only an absolute folder", () => {
    expect(enterLeadingCd("cd ./x && rm -f a", undefined)).toBeNull();
    if (process.platform !== "win32") expect(enterLeadingCd("cd /tmp && rm -f a", undefined)).toEqual({ command: "rm -f a", cwd: "/tmp" });
  });

  it("never a bare name (CDPATH), an expansion, `-`, or a cd chained with ;", () => {
    for (const command of ["cd x && rm -f a", "cd $D && rm -f a", "cd - && rm -f a", "cd /tmp; rm -f a"]) {
      expect(enterLeadingCd(command, cwd), command).toBeNull();
    }
  });
});

describe("enterPrelude", () => {
  it("skips inert commands on both sides of one leading cd", () => {
    const cwd = resolve("/work/proj");
    expect(enterPrelude("command -v cpio; cd ../tmp && echo go && rm -rf x", cwd))
      .toEqual({ command: "rm -rf x", cwd: resolve(cwd, "../tmp") });
  });
});
