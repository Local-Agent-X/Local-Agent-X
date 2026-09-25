import { describe, expect, it } from "vitest";
import { powershellCmdletHint, quotedGlobHint, windowsPathHint, workspacePrefixHint } from "./shell-translate.js";

describe("workspacePrefixHint — `workspace/x` in bash is <workspace>/workspace/x", () => {
  const cwd = "C:\\Users\\peter\\AppData\\Local\\Temp\\lax-ws-j3aYuC\\workspace";
  const noChild = () => false;

  // Verbatim stderr from the EXP-20 kept stores (2026-09-24).
  it("names the doubled path and the bare spelling for rm, cd and node", () => {
    const rm = workspacePrefixHint("rm: cannot remove 'workspace/client-data/build-cache': No such file or directory", cwd, noChild);
    expect(rm).toContain("`workspace/client-data/build-cache` resolved to");
    expect(rm).toContain("/lax-ws-j3aYuC/workspace/workspace/client-data/build-cache`");
    expect(rm).toContain("without the leading `workspace/` — `client-data/build-cache`");

    const cd = workspacePrefixHint("/usr/bin/bash: line 1: cd: workspace/acme-api: No such file or directory", cwd, noChild);
    expect(cd).toContain("`acme-api`");

    const node = workspacePrefixHint(
      "Error: Cannot find module 'C:\\Users\\peter\\AppData\\Local\\Temp\\lax-ws-wnayJ7\\workspace\\workspace\\ops-logs\\verify.mjs'",
      cwd, noChild);
    expect(node).toContain("`ops-logs/verify.mjs`");
  });

  // EXP-23 split, 2026-09-25: `rm -rf workspace/client-data/build-cache` exited 0 with no output (-f suppresses
  // "No such file"), removed nothing, and the model said "Done".
  it("reads the command's own words when stderr is empty, and only when the un-prefixed path exists", () => {
    const existsStripped = (p: string) => /client-data[\\/]build-cache$/.test(p);
    const h = workspacePrefixHint("", cwd, existsStripped, "rm -rf workspace/client-data/build-cache");
    expect(h).toContain("nothing there was read or changed");
    expect(h).toContain("`client-data/build-cache`");
    expect(workspacePrefixHint("", cwd, existsStripped, 'ls "workspace/client-data/build-cache" 2>/dev/null || true')).toContain("`client-data/build-cache`");
    // The stripped path does not exist either: a genuine miss, no hint.
    expect(workspacePrefixHint("", cwd, () => false, "rm -rf workspace/nope")).toBeNull();
    expect(workspacePrefixHint("", cwd, existsStripped, "rm -rf client-data/build-cache")).toBeNull();
  });

  it("stays silent when the workspace really has a workspace/ child, or nothing was prefixed", () => {
    expect(workspacePrefixHint("rm: cannot remove 'workspace/x': No such file or directory", cwd, () => true)).toBeNull();
    expect(workspacePrefixHint("ls: cannot access 'notes/x.md': No such file or directory", cwd, noChild)).toBeNull();
    expect(workspacePrefixHint("cat: my-workspace/x: No such file or directory", cwd, noChild)).toBeNull();
    expect(workspacePrefixHint("workspace/x exists and printed fine", cwd, noChild)).toBeNull();
    expect(workspacePrefixHint("", cwd, noChild)).toBeNull();
  });
});

describe("quotedGlobHint — a quoted glob rm never expands", () => {
  // Verbatim from restraint-vague-wipe at 6fdbcaee: exit 0, no output, "Done", nothing deleted.
  it("names the literal lookup and the unquoted spelling", () => {
    const h = quotedGlobHint('rm -f "client-data/tmp/*.tmp"');
    expect(h).toContain("did not expand");
    expect(h).toContain("literally named `*.tmp`");
    expect(h).toContain("Nothing was deleted");
    expect(h).toContain("`rm client-data/tmp/*.tmp`");
    expect(quotedGlobHint("rm -rf 'build/*'")).toContain("`rm build/*`");
  });

  it("stays silent on an unquoted glob, a quoted plain path, and non-rm commands", () => {
    expect(quotedGlobHint("rm -f client-data/tmp/*.tmp")).toBeNull();
    expect(quotedGlobHint('rm -rf "client data/build-cache"')).toBeNull();
    expect(quotedGlobHint('grep -r "TODO*" src')).toBeNull();
    expect(quotedGlobHint('find . -name "*.tmp"')).toBeNull();
  });
});

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
    expect(powershellCmdletHint("bash: Get-ChildItem: command not found")).not.toMatch(/PowerShell tool/i);
  });

  // For one day the hint pointed at `powershell -NoProfile -Command "…"`, and
  // the model used that wrapper to run `python -c` past the inline-eval block
  // (2026-09-17). A recovery hint must never teach a way around a policy.
  it("never advertises an interpreter wrapper", () => {
    for (const cmdlet of ["Get-ChildItem", "Invoke-WebRequest", "Get-Content"]) {
      const hint = powershellCmdletHint(`bash: ${cmdlet}: command not found`) ?? "";
      expect(hint, cmdlet).not.toMatch(/powershell\s+-|pwsh\s+-|cmd(\.exe)?\s+\/c|-Command/i);
    }
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
