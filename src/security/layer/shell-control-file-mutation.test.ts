// The file tools refuse to rewrite the data dir's security switches in every
// file-access mode. bash did not: unrestricted mode skipped path confinement
// entirely, so `echo … > ~/.lax/autonomy-profile.json` rewrote the agent's own
// permissions on an uncaged host (red team 2026-10-13, C2). The shell now
// answers to the same authority, while reads and every other write in
// unrestricted mode stay as they were.
import { describe, expect, it } from "vitest";
import { join } from "node:path";
import { getLaxDir } from "../../lax-data-dir.js";
import { laxControlFileBasenames } from "./lax-control-files.js";
import { detectControlFileMutation, shellMutationTargets } from "./shell-mutation-guard.js";
import { evaluateShellCommandAndPaths, type ShellPathGuardCtx } from "./shell-path-guard.js";

const lax = getLaxDir();
const control = join(lax, ...laxControlFileBasenames()[0].split("/"));
const unrestricted: ShellPathGuardCtx = {
  workspace: join(lax, "workspace"),
  fileAccessMode: "unrestricted",
  inlineEvalPolicy: "allow",
  sandboxConfined: false,
  allowedPathCheck: () => true,
};

describe("a shell command that would change a control file", () => {
  it("is refused for a redirect, a copy, a move, a delete and a dd, in unrestricted mode", () => {
    for (const command of [
      `echo '{}' > "${control}"`,
      `cp /tmp/profile.json "${control}"`,
      `mv /tmp/profile.json "${control}"`,
      `rm -f "${control}"`,
      `dd if=/dev/zero of="${control}"`,
      `tee "${control}" < /tmp/x`,
    ]) {
      expect(detectControlFileMutation(command), command).toMatch(/control file/);
      const decision = evaluateShellCommandAndPaths(command, unrestricted);
      expect(decision.allowed, command).toBe(false);
      expect(decision.reason, command).toMatch(/control file/);
    }
  });

  it("leaves a read of the same file, and a write anywhere else, alone", () => {
    expect(detectControlFileMutation(`cat "${control}"`)).toBeNull();
    expect(detectControlFileMutation(`echo hi > "${join(lax, "workspace", "notes.txt")}"`)).toBeNull();
    expect(detectControlFileMutation(`cp "${control}" /tmp/backup.json`)).toBeNull();
    expect(evaluateShellCommandAndPaths(`cat "${control}"`, unrestricted).allowed).toBe(true);
    expect(evaluateShellCommandAndPaths(`echo hi > "${join(lax, "workspace", "notes.txt")}"`, unrestricted).allowed).toBe(true);
  });

  it("names every absolute write target with its verb, and no read", () => {
    const targets = shellMutationTargets(`cat /a/in > /a/out && cp /a/out /b/dest; rm /c/gone`);
    expect(targets).toEqual([
      { path: "/a/out", verb: "redirect" },
      { path: "/b/dest", verb: "cp" },
      { path: "/c/gone", verb: "rm" },
    ]);
  });
});
