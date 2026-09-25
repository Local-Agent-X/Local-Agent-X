// The Runtime section must agree with the bash tool: the shell it names is the
// one the tool spawns, the verbs are POSIX everywhere, and the working
// directory is the workspace every relative path anchors to — never the server
// process's cwd. Until 2026-09-25 it said "PowerShell … Use PowerShell verbs"
// on Windows while the tool ran Git Bash, and named process.cwd(); the model
// followed the prompt and every shell path failed (op-outcomes EXP-20 stores).
import { describe, expect, it } from "vitest";
import { runtimeSection } from "./runtime-section.js";

const WS = "C:\\Users\\peter\\.lax\\workspace";

describe("runtimeSection — the prompt tells the truth about the shell and the cwd", () => {
  it("Windows with Git Bash: names Git Bash, POSIX verbs, and forbids the cmdlets", () => {
    const s = runtimeSection("win32", "bash", WS);
    expect(s).toContain("Git Bash (POSIX sh)");
    expect(s).toContain("Write POSIX sh");
    expect(s).toContain("NEVER `Remove-Item`");
    expect(s).not.toMatch(/Use PowerShell verbs/);
  });

  it("Windows without Git Bash: names the PowerShell fallback and STILL asks for POSIX sh (the tool translates)", () => {
    for (const kind of ["pwsh", "powershell"] as const) {
      const s = runtimeSection("win32", kind, WS);
      expect(s).toContain("no Git Bash was found");
      expect(s).toContain("Write POSIX sh");
      expect(s).not.toMatch(/Use PowerShell verbs/);
    }
  });

  it("macOS and Linux: POSIX verbs, no Windows text", () => {
    expect(runtimeSection("darwin", null, "/Users/p/.lax/workspace")).toContain("zsh/bash");
    expect(runtimeSection("linux", null, "/home/p/.lax/workspace")).toContain("- Shell behind the `bash` tool: bash.");
    expect(runtimeSection("linux", null, "/home/p/.lax/workspace")).not.toContain("PowerShell 7");
  });

  it("the working directory is the workspace handed in, with the workspace/-prefix rule", () => {
    const s = runtimeSection("win32", "bash", WS);
    expect(s).toContain(`- Working directory: ${WS} — the workspace.`);
    expect(s).toContain("never prefix a path with `workspace/`");
    expect(s).not.toContain(process.cwd());
  });
});
