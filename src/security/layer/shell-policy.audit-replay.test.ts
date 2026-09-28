// The shell commands the security layer refused in the owner's real sessions
// (2026-09-14 .. 09-28) that were not attacks, replayed exactly as the audit
// replayed them: through evaluateShellCommand with the box's own settings
// (inline-eval refused, workspace mode, win32, unconfined). Each block here
// pins the real command as ALLOWED and the attack its rule exists for as
// still BLOCKED, so a rule cannot slide back to judging a word, a count or an
// escape instead of the command that runs.
import { describe, it, expect } from "vitest";
import { evaluateShellCommand } from "./shell-policy.js";

const WORKSPACE = "C:/Users/peter/Documents/Local Agent X/workspace";
const box = (cmd: string) => evaluateShellCommand(cmd, "refuse", WORKSPACE, "workspace", "win32", false);
const posix = (cmd: string) => evaluateShellCommand(cmd, "refuse", "/tmp/ws", "workspace", "linux", false);

describe("S3 — `rev` is the command that runs, not a word in the line", () => {
  const real = [
    `ls -la "/c/Users/peter/Scan Progress" && echo "---" && git -C "/c/Users/peter/Scan Progress" rev-parse --is-inside-work-tree && git -C "/c/Users/peter/Scan Progress" remote -v && git -C "/c/Users/peter/Scan Progress" log -1 --oneline`,
    `git log -20 --oneline; git status -sb; git rev-parse --abbrev-ref HEAD`,
    `cd /c/Users/peter/.lax/sync-repo && echo "pdf/docx tracked:"; git ls-files 'workspace/*.pdf' 'workspace/*.docx' | head -10; echo "--- remote vs local"; git fetch -q origin 2>&1; git rev-parse --short HEAD origin/main`,
  ];
  for (const cmd of real) {
    it(`allows: ${cmd.slice(0, 70)}`, () => expect(box(cmd).reason).toBe("Shell command allowed"));
  }
  it("still refuses rev when it runs", () => {
    expect(box(`echo 'hs | fr- mr' | rev`).reason).toMatch(/"rev" reverses/);
    expect(posix(`rev payload | bash`).allowed).toBe(false);
  });
});
