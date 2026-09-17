import { describe, expect, it } from "vitest";
import { powershellCmdletHint, windowsPathHint } from "./shell-translate.js";

describe("windowsPathHint — a Windows path whose backslashes bash ate", () => {
  // Verbatim stderr from the two muse sessions on 2026-09-16.
  it("names the mangled path and the fix, for a command", () => {
    const hint = windowsPathHint("/usr/bin/bash: line 1: C:UserspeterAppDataLocalProgramsPythonPython312python.exe: command not found");
    expect(hint).toContain("C:UserspeterAppDataLocalProgramsPythonPython312python.exe");
    expect(hint).toContain("forward slashes");
  });

  it("names it for an ls of a mangled path too", () => {
    expect(windowsPathHint("ls: cannot access 'C:UserspeterDocumentsLocal': No such file or directory")).toContain("C:UserspeterDocumentsLocal");
  });

  it("stays silent on real paths and unrelated failures", () => {
    expect(windowsPathHint("ls: cannot access 'C:/Users/peter/x': No such file or directory")).toBeNull();
    expect(windowsPathHint("ls: cannot access '/c/Users/peter/x': No such file or directory")).toBeNull();
    expect(windowsPathHint("bash: line 1: frobnicate: command not found")).toBeNull();
    expect(windowsPathHint("Traceback: File C:Users is not a real error form")).toBeNull();
    expect(windowsPathHint("")).toBeNull();
  });
});

describe("powershellCmdletHint — coach a PowerShell cmdlet fired into the bash tool", () => {
  it("names the cmdlet and the POSIX equivalent for a known one", () => {
    const hint = powershellCmdletHint("/usr/bin/bash: line 1: Get-ChildItem: command not found");
    expect(hint).toContain("Get-ChildItem");
    expect(hint).toContain("ls");
  });

  // It used to send the model to "the PowerShell tool", which does not exist.
  // A recovery hint may only name something the model can actually reach.
  it("never names a tool that does not exist", () => {
    for (const platform of ["win32", "linux", "darwin"] as const) {
      expect(powershellCmdletHint("bash: Get-ChildItem: command not found", platform)).not.toMatch(/PowerShell tool/i);
    }
  });

  it("on Windows, offers PowerShell the way it is really reachable — through bash", () => {
    expect(powershellCmdletHint("bash: Get-ChildItem: command not found", "win32"))
      .toContain('powershell -NoProfile -Command "Get-ChildItem');
    expect(powershellCmdletHint("bash: Get-ChildItem: command not found", "linux")).not.toContain("powershell -NoProfile");
  });

  it("handles the exact cmdlets that misfired in the field", () => {
    expect(powershellCmdletHint("bash: line 1: Select-Object: command not found")).toContain("head");
    expect(powershellCmdletHint("bash: Get-Content: command not found")).toContain("cat");
  });

  it("still steers even when the cmdlet isn't in the POSIX map", () => {
    const hint = powershellCmdletHint("bash: Invoke-WebRequest: command not found");
    expect(hint).toContain("Invoke-WebRequest");
    expect(hint).toContain("POSIX equivalent");
  });

  it("returns null for a genuine bash failure (no cmdlet)", () => {
    expect(powershellCmdletHint("bash: line 1: frobnicate: command not found")).toBeNull();
    expect(powershellCmdletHint("grep: invalid option -- 'z'")).toBeNull();
    expect(powershellCmdletHint("")).toBeNull();
  });

  it("does not fire on a lowercase hyphenated binary name", () => {
    expect(powershellCmdletHint("bash: docker-compose: command not found")).toBeNull();
  });
});
