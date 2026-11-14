/**
 * Two false refusals from the 2026-11-13 LAX-vs-Claude-Code run (workspace
 * mode): a relative path after `cd <project> &&` was resolved from the
 * workspace instead of the project, and a grep pattern like "/src/" was
 * checked as a folder at the root of the drive. Neither fix may let a real
 * file outside the workspace through.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { evaluateShellPaths } from "./shell-path-guard.js";
import { searchPatternOperand } from "./search-pattern-operand.js";

const WIN = process.platform === "win32";
const OUTSIDE = WIN ? "C:/Windows/System32/drivers/etc/hosts" : "/etc/hosts";

let root: string;
let workspace: string;
beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "lax-cdpat-")));
  workspace = join(root, "workspace");
  mkdirSync(join(workspace, "proj", "src"), { recursive: true });
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const check = (command: string) =>
  evaluateShellPaths(command, { workspace, fileAccessMode: "workspace", allowedPathCheck: () => false });
const fwd = (p: string) => p.replace(/\\/g, "/");

describe("a relative path after cd is placed in the folder the cd entered", () => {
  it("allows ../ from a project inside the workspace", () => {
    const proj = fwd(join(workspace, "proj"));
    expect(check(`cd "${proj}" && ls ../proj/src`).allowed).toBe(true);
    expect(check(`cd "${proj}" && ls src && cat ../proj/src/index.ts`).allowed).toBe(true);
  });

  it("still refuses a relative path that climbs out of the workspace from there", () => {
    const proj = fwd(join(workspace, "proj"));
    expect(check(`cd "${proj}" && cat ../../outside.txt`).allowed).toBe(false);
  });

  it("leaves a path after a cd it cannot place relative to the workspace, as before", () => {
    expect(check("cd $SOMEWHERE && ls ../../x").allowed).toBe(false);
  });
});

describe("a grep/rg search pattern is not checked as a file", () => {
  it("allows a pattern that looks like a root path", () => {
    expect(check('grep -c "/src/" proj/src/a.ts').allowed).toBe(true);
    expect(check('rg -n "/etc/" proj').allowed).toBe(true);
  });

  it("still checks every file operand, and a pattern file", () => {
    expect(check(`grep secret ${OUTSIDE}`).allowed).toBe(false);
    expect(check(`grep -A 3 secret ${OUTSIDE}`).allowed).toBe(false);
    expect(check(`grep -f ${OUTSIDE} proj/src/a.ts`).allowed).toBe(false);
    expect(check(`grep -rf ${OUTSIDE} proj`).allowed).toBe(false);
  });

  it("skips nothing when a redirect-looking word could hide which operand is the pattern", () => {
    expect(check(`grep ">x" ${OUTSIDE}`).allowed).toBe(false);
  });
});

describe("searchPatternOperand", () => {
  const at = (cmd: string) => { const w = cmd.split(" "); return searchPatternOperand(w, 0, w[0]); };
  it("finds the first operand after flags and their values", () => {
    expect(at("grep -n pat a.ts")).toBe(2);
    expect(at("grep -A 3 pat a.ts")).toBe(3);
    expect(at("grep --include *.ts pat src")).toBe(3);
    expect(at("grep --include=*.ts pat src")).toBe(2);
    expect(at("grep -- -pat a.ts")).toBe(2);
  });
  it("finds none when a flag supplies the pattern, or for other commands", () => {
    expect(at("grep -e pat a.ts")).toBe(-1);
    expect(at("grep --regexp=pat a.ts")).toBe(-1);
    expect(at("grep -rf pats.txt src")).toBe(-1);
    expect(at("cat pat a.ts")).toBe(-1);
  });
});
