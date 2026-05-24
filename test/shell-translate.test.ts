import { describe, it, expect } from "vitest";
import { detectTargetShell, translateForShell, countTopLevelPipes } from "../src/tools/shell-translate.js";

describe("detectTargetShell — cross-platform", () => {
  it("classifies Windows pwsh 7+ as pwsh-7", () => {
    expect(detectTargetShell("C:\\Program Files\\PowerShell\\7\\pwsh.exe")).toBe("pwsh-7");
    expect(detectTargetShell("pwsh.exe")).toBe("pwsh-7");
  });

  it("classifies Windows PS 5.1 as powershell-51", () => {
    expect(detectTargetShell("C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe")).toBe("powershell-51");
    expect(detectTargetShell("powershell.exe")).toBe("powershell-51");
  });

  it("classifies Mac/Linux bash as bash", () => {
    expect(detectTargetShell("/bin/bash")).toBe("bash");
    expect(detectTargetShell("/usr/bin/bash")).toBe("bash");
  });

  it("classifies pwsh on Mac/Linux (no .exe) as pwsh-7", () => {
    expect(detectTargetShell("/usr/local/bin/pwsh")).toBe("pwsh-7");
  });

  it("is case-insensitive for Windows paths", () => {
    expect(detectTargetShell("C:\\WINDOWS\\System32\\WindowsPowerShell\\v1.0\\POWERSHELL.EXE")).toBe("powershell-51");
  });
});

describe("translateForShell — no-ops on bash + pwsh-7", () => {
  it("returns bash commands unchanged on a Mac/Linux user box", () => {
    const cmd = 'cd /tmp && grep -r "foo" . 2>/dev/null || echo "none"';
    expect(translateForShell(cmd, "bash")).toBe(cmd);
  });

  it("returns POSIX-style commands unchanged when target is pwsh 7+", () => {
    const cmd = 'cd C:\\foo && grep bar . 2>/dev/null';
    expect(translateForShell(cmd, "pwsh-7")).toBe(cmd);
  });
});

describe("translateForShell — PS 5.1 chain translation", () => {
  it("translates `a && b` to short-circuit if-block", () => {
    expect(translateForShell("cd x && grep y", "powershell-51"))
      .toBe("cd x; if ($?) { grep y }");
  });

  it("nests for `a && b && c` so c only runs if both a and b succeed", () => {
    expect(translateForShell("cd x && cd y && grep z", "powershell-51"))
      .toBe("cd x; if ($?) { cd y; if ($?) { grep z } }");
  });

  it("translates `a || b` to negated if-block", () => {
    expect(translateForShell("git pull || echo failed", "powershell-51"))
      .toBe("git pull; if (-not $?) { echo failed }");
  });

  it("nests for pure || chains", () => {
    expect(translateForShell("a || b || c", "powershell-51"))
      .toBe("a; if (-not $?) { b; if (-not $?) { c } }");
  });

  it("does not touch && inside single-quoted strings", () => {
    expect(translateForShell("echo 'a && b' && ls", "powershell-51"))
      .toBe("echo 'a && b'; if ($?) { ls }");
  });

  it("does not touch && inside double-quoted strings", () => {
    expect(translateForShell('echo "a && b" && ls', "powershell-51"))
      .toBe('echo "a && b"; if ($?) { ls }');
  });

  it("leaves a command with no chains untouched", () => {
    expect(translateForShell("git status", "powershell-51")).toBe("git status");
  });
});

describe("translateForShell — PS 5.1 /dev/null translation", () => {
  it("rewrites 2>/dev/null to 2>$null", () => {
    expect(translateForShell("grep foo bar.txt 2>/dev/null", "powershell-51"))
      .toBe("grep foo bar.txt 2>$null");
  });

  it("rewrites >/dev/null to >$null", () => {
    expect(translateForShell("ls >/dev/null", "powershell-51"))
      .toBe("ls >$null");
  });

  it("rewrites 1>/dev/null to 1>$null", () => {
    expect(translateForShell("ls 1>/dev/null", "powershell-51"))
      .toBe("ls 1>$null");
  });

  it("does not touch /dev/null at the start of a string (no leading whitespace match)", () => {
    expect(translateForShell("echo '/dev/null is special'", "powershell-51"))
      .toBe("echo '/dev/null is special'");
  });

  it("composes redirects + chains in one pass", () => {
    expect(translateForShell("git pull 2>/dev/null && npm install", "powershell-51"))
      .toBe("git pull 2>$null; if ($?) { npm install }");
  });
});

describe("countTopLevelPipes — quote-aware pipe counting", () => {
  it("counts top-level pipes in a simple command", () => {
    expect(countTopLevelPipes("ls | grep foo | sort | uniq | head")).toBe(4);
  });

  it("returns 0 for a command with no pipes", () => {
    expect(countTopLevelPipes("git status")).toBe(0);
  });

  it("does not count pipes inside double-quoted strings", () => {
    expect(countTopLevelPipes('echo "a|b|c|d|e|f|g|h"')).toBe(0);
  });

  it("does not count pipes inside single-quoted strings", () => {
    expect(countTopLevelPipes("echo 'a|b|c|d|e|f'")).toBe(0);
  });

  it("counts top-level pipes correctly when quotes contain pipes", () => {
    expect(countTopLevelPipes('echo "a|b" | grep foo | sort')).toBe(2);
  });

  it("does not count `||` (logical OR) as a pipe", () => {
    expect(countTopLevelPipes("git pull || echo failed")).toBe(0);
  });

  it("counts a single `|` next to `||` correctly", () => {
    expect(countTopLevelPipes("ls | grep foo || echo none")).toBe(1);
  });

  it("handles nested quotes correctly", () => {
    expect(countTopLevelPipes(`grep "a 'b|c' d" file | sort`)).toBe(1);
  });
});

describe("translateForShell — repeating-text repro (2026-05-23)", () => {
  it("translates the exact command that aborted Grok's 14-tool turn", () => {
    const cmd = 'cd "C:\\Users\\manri\\local-agent-x\\workspace\\apps\\super-peter-bros" && grep -r "speed" .';
    expect(translateForShell(cmd, "powershell-51"))
      .toBe('cd "C:\\Users\\manri\\local-agent-x\\workspace\\apps\\super-peter-bros"; if ($?) { grep -r "speed" . }');
  });
});
