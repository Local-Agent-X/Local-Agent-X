import { describe, expect, it } from "vitest";
import { powershellCmdletHint } from "./shell-translate.js";

describe("powershellCmdletHint — coach a PowerShell cmdlet fired into the bash tool", () => {
  it("names the cmdlet and the POSIX equivalent for a known one", () => {
    const hint = powershellCmdletHint("/usr/bin/bash: line 1: Get-ChildItem: command not found");
    expect(hint).toContain("Get-ChildItem");
    expect(hint).toContain("ls");
    expect(hint).toContain("PowerShell tool");
  });

  it("handles the exact cmdlets that misfired in the field", () => {
    expect(powershellCmdletHint("bash: line 1: Select-Object: command not found")).toContain("head");
    expect(powershellCmdletHint("bash: Get-Content: command not found")).toContain("cat");
  });

  it("still steers even when the cmdlet isn't in the POSIX map", () => {
    const hint = powershellCmdletHint("bash: Invoke-WebRequest: command not found");
    expect(hint).toContain("Invoke-WebRequest");
    expect(hint).toContain("PowerShell tool");
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
