import { describe, it, expect } from "vitest";

import { buildWin32ScanScript } from "../src/reap-stale-procs.js";

describe("buildWin32ScanScript", () => {
  it("keeps backslashes literal so a real Windows path actually matches", () => {
    const script = buildWin32ScanScript({
      processNames: ["node.exe"],
      cmdlineContains: "C:\\Users\\manri\\local-agent-x\\src\\mcp-bridge",
      label: "t",
    });
    // The needle must appear with single backslashes (lowercased). A double
    // backslash here is the old bug — `.Contains` would never fire.
    expect(script).toContain("'c:\\users\\manri\\local-agent-x\\src\\mcp-bridge'");
    expect(script).not.toContain("\\\\");
  });

  it("emits the CreationDate age guard only when olderThan is set", () => {
    const base = {
      processNames: ["node.exe"],
      cmdlineContains: "x",
      label: "t",
    };
    expect(buildWin32ScanScript(base)).not.toContain("CreationDate");

    const cutoff = new Date(1_700_000_000_000);
    const guarded = buildWin32ScanScript({ ...base, olderThan: cutoff });
    expect(guarded).toContain("ToUnixTimeMilliseconds() -lt 1700000000000");
  });

  it("doubles single quotes to stay inside the PowerShell string literal", () => {
    const script = buildWin32ScanScript({
      processNames: ["node.exe"],
      cmdlineContains: "a'b",
      label: "t",
    });
    expect(script).toContain("Contains('a''b')");
  });

  it("ORs multiple process names in the CIM filter", () => {
    const script = buildWin32ScanScript({
      processNames: ["chrome.exe", "msedge.exe"],
      cmdlineContains: "x",
      label: "t",
    });
    expect(script).toContain("Name='chrome.exe' OR Name='msedge.exe'");
  });
});
