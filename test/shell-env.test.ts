import { describe, it, expect } from "vitest";
import { buildSanitizedEnv, resolveWindowsShell, isLikelyAvKill, portableGitBashPath } from "../src/tools/shell-env.js";
import { detectTargetShell, translateForShell } from "../src/tools/shell-translate.js";

const isWin = process.platform === "win32";

// Fix E regression: a private-repo `git clone` in the agent shell hung on
// `/dev/tty: No such device` because git tried to prompt for credentials with
// no controlling TTY. The shared env builder now forces non-interactive git so
// a missing credential fails fast instead of hanging.
describe("buildSanitizedEnv — non-interactive git (no /dev/tty hang)", () => {
  it("forces GIT_TERMINAL_PROMPT=0", () => {
    expect(buildSanitizedEnv().GIT_TERMINAL_PROMPT).toBe("0");
  });
  it("defaults GIT_ASKPASS to empty (no askpass prompt)", () => {
    expect(buildSanitizedEnv().GIT_ASKPASS).toBe("");
  });
  it("forces GIT_ASKPASS empty even when the ambient env sets one (VS Code terminal)", () => {
    // VS Code's integrated terminal exports GIT_ASKPASS pointing at its own
    // askpass.sh; it must not survive into the agent shell or git can hang on a
    // credential prompt. Env-independent guard — the default-when-unset bug only
    // surfaced in shells that already had GIT_ASKPASS set.
    const prev = process.env.GIT_ASKPASS;
    process.env.GIT_ASKPASS = "/Applications/Visual Studio Code.app/Contents/Resources/app/extensions/git/dist/askpass.sh";
    try {
      expect(buildSanitizedEnv().GIT_ASKPASS).toBe("");
    } finally {
      if (prev === undefined) delete process.env.GIT_ASKPASS;
      else process.env.GIT_ASKPASS = prev;
    }
  });
  it("lets an explicit caller override the default", () => {
    expect(buildSanitizedEnv({ GIT_TERMINAL_PROMPT: "1" }).GIT_TERMINAL_PROMPT).toBe("1");
    expect(buildSanitizedEnv({ GIT_ASKPASS: "/my/askpass" }).GIT_ASKPASS).toBe("/my/askpass");
  });
});

// Regression: a non-interactive agent shell hung when `git log`/`git diff`/
// `git branch` (or `man`/`less`/`psql`) piped to a pager that blocks for `q`
// with no TTY. The env builder forces a straight-through pager so the command
// returns instead of stalling to the timeout.
describe("buildSanitizedEnv — non-blocking pager (no git/less hang)", () => {
  it("forces GIT_PAGER and PAGER to cat", () => {
    const env = buildSanitizedEnv();
    expect(env.GIT_PAGER).toBe("cat");
    expect(env.PAGER).toBe("cat");
  });
  it("lets an explicit caller opt back into a pager", () => {
    expect(buildSanitizedEnv({ PAGER: "less" }).PAGER).toBe("less");
  });
});

// Fix A regression: on Windows the `bash` tool ran the model's POSIX commands
// through PowerShell (translating a few idioms), and a literal `bash` resolved
// to the WSL launcher (System32\bash.exe → "execvpe(/bin/bash) failed"). The
// resolver now selects a real Git Bash when present and NEVER the WSL launcher.
describe("resolveWindowsShell — deterministic POSIX shell, never the WSL launcher", () => {
  it("returns a validated shell with a known kind and non-empty path", () => {
    const s = resolveWindowsShell();
    expect(["bash", "pwsh", "powershell"]).toContain(s.kind);
    expect(typeof s.path).toBe("string");
    expect(s.path.length).toBeGreaterThan(0);
  });

  it("never selects the WSL launcher (System32\\bash.exe / WindowsApps stub)", () => {
    const lower = resolveWindowsShell().path.toLowerCase().replace(/\//g, "\\");
    expect(lower).not.toContain("\\system32\\bash.exe");
    expect(lower).not.toContain("\\windowsapps\\");
  });

  it.runIf(isWin)("selects a real Git Bash on Windows (Git for Windows is installed here)", () => {
    const s = resolveWindowsShell();
    expect(s.kind).toBe("bash");
    expect(s.path.toLowerCase()).toMatch(/bash\.exe$/);
  });

  it("a bash shell path skips POSIX→PS translation so commands run natively", () => {
    // The contract the fix depends on: detectTargetShell on a bash path yields
    // a no-op translation target, so a real POSIX command is passed through
    // unchanged instead of being rewritten for PowerShell.
    const target = detectTargetShell("C:/Program Files/Git/bin/bash.exe");
    expect(target).toBe("bash");
    const cmd = "ls -la | grep foo && echo done > /dev/null";
    expect(translateForShell(cmd, target)).toBe(cmd);
  });
});

// install-common.mjs provisions PortableGit to a fixed dir and the runtime
// resolver reads bash.exe from it. That path is ONE fact in two files (this
// resolver + scripts/portable-git.mjs portableGitExtractDir) — if they drift,
// the installer writes bash where the resolver never looks. This locks the
// resolver side; test/portable-git.test.ts locks the installer side.
describe("portableGitBashPath — load-bearing coupling with portable-git.mjs", () => {
  it("builds …\\LocalAgentX\\PortableGit\\bin\\bash.exe under LOCALAPPDATA", () => {
    const p = portableGitBashPath("C:\\Users\\x\\AppData\\Local");
    // Normalize separators so the assertion is host-agnostic (join uses the
    // platform separator; the coupling is about the path segments, not the slash).
    expect(p?.replace(/\//g, "\\")).toBe(
      "C:\\Users\\x\\AppData\\Local\\LocalAgentX\\PortableGit\\bin\\bash.exe",
    );
  });
  it("returns null when LOCALAPPDATA is unset (no Windows env → no candidate)", () => {
    expect(portableGitBashPath(undefined)).toBeNull();
  });
});

// AV behavior-shields hunt powershell.exe; a signed Git Bash isn't that target.
// Regression: once Git Bash became the default shell, a "command not found"
// (exit 127, fast, no stdout) under bash was misreported as an "antivirus
// signature". The heuristic is now PowerShell-only and excludes exit 127.
describe("isLikelyAvKill — AV detection scoped to the PowerShell path", () => {
  const avSignature = { code: null as number | null, elapsedMs: 80, stdoutLen: 0, cmdLen: 20 };

  it("fires for the real AV signature on the PowerShell path", () => {
    expect(isLikelyAvKill({ isPowerShell: true, ...avSignature })).toBe(true);
    expect(isLikelyAvKill({ isPowerShell: true, code: 3221225794, elapsedMs: 120, stdoutLen: 0, cmdLen: 30 })).toBe(true);
  });

  it("does NOT fire under Git Bash (signed bash.exe is not the AV target)", () => {
    // Same fast no-output failure, but bash path → a normal command error, not AV.
    expect(isLikelyAvKill({ isPowerShell: false, ...avSignature })).toBe(false);
    expect(isLikelyAvKill({ isPowerShell: false, code: 127, elapsedMs: 81, stdoutLen: 0, cmdLen: 13 })).toBe(false);
  });

  it("excludes exit 127 (command-not-found) even on the PowerShell path", () => {
    expect(isLikelyAvKill({ isPowerShell: true, code: 127, elapsedMs: 81, stdoutLen: 0, cmdLen: 13 })).toBe(false);
  });

  it("ignores clean/expected exits, slow deaths, output, and trivial commands", () => {
    expect(isLikelyAvKill({ isPowerShell: true, code: 0, elapsedMs: 50, stdoutLen: 0, cmdLen: 20 })).toBe(false);
    expect(isLikelyAvKill({ isPowerShell: true, code: 1, elapsedMs: 50, stdoutLen: 0, cmdLen: 20 })).toBe(false);
    expect(isLikelyAvKill({ isPowerShell: true, ...avSignature, elapsedMs: 1500 })).toBe(false);
    expect(isLikelyAvKill({ isPowerShell: true, ...avSignature, stdoutLen: 200 })).toBe(false);
    expect(isLikelyAvKill({ isPowerShell: true, ...avSignature, cmdLen: 4 })).toBe(false);
  });
});
