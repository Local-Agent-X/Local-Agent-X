import { describe, expect, it } from "vitest";
import { shellDeleteTargets, shellWords } from "./shell-delete-targets.js";

describe("shellWords", () => {
  it("reads quoted paths with spaces and keeps backslashes inside single quotes", () => {
    expect(shellWords(`rm "client data/a b.md" 'C:\\Users\\x\\y.md' plain`)).toEqual(["rm", "client data/a b.md", "C:\\Users\\x\\y.md", "plain"]);
    expect(shellWords(`rm a\\ b.md`)).toEqual(["rm", "a b.md"]);
    expect(shellWords(`rm ""`)).toEqual(["rm", ""]);
  });
});

describe("shellDeleteTargets — the single-file deletes EXP-18 fell through to", () => {
  it("lists every file of a per-file rm ladder, across segments", () => {
    const cmd = "rm workspace/client-data/tmp/thumbnail-cache.tmp && rm workspace/client-data/originals/handover-notes.md; rm -f workspace/client-data/originals/invoice-0042.md";
    expect(shellDeleteTargets(cmd)).toEqual([
      "workspace/client-data/tmp/thumbnail-cache.tmp",
      "workspace/client-data/originals/handover-notes.md",
      "workspace/client-data/originals/invoice-0042.md",
    ]);
  });

  it("reads Remove-Item through a powershell -Command wrapper, with -Force and -Path", () => {
    expect(shellDeleteTargets(`powershell -Command "Remove-Item 'workspace/client-data/originals/invoice-0042.md' -Force"`))
      .toEqual(["workspace/client-data/originals/invoice-0042.md"]);
    expect(shellDeleteTargets(`Remove-Item -Path "a.md","b.md" -Force; del /Q c.tmp`)).toEqual(["a.md", "b.md", "c.tmp"]);
    expect(shellDeleteTargets(`pwsh -c "ri 'x y.md'"`)).toEqual(["x y.md"]);
  });

  it("leaves the recursive forms to the irreversible floor — no second card", () => {
    expect(shellDeleteTargets("rm -rf workspace/client-data/tmp workspace/client-data/originals")).toEqual([]);
    expect(shellDeleteTargets("rm -r build")).toEqual([]);
    expect(shellDeleteTargets("rm --recursive build")).toEqual([]);
    expect(shellDeleteTargets(`powershell -Command "Remove-Item 'build' -Recurse -Force"`)).toEqual([]);
  });

  it("ignores commands that delete nothing, and git rm", () => {
    expect(shellDeleteTargets("ls -la client-data/tmp/ && cat README.md")).toEqual([]);
    expect(shellDeleteTargets("git rm --cached notes.txt")).toEqual([]);
    expect(shellDeleteTargets("echo rm this")).toEqual([]);
    expect(shellDeleteTargets("grep -rn 'rm ' src")).toEqual([]);
  });

  it("cd then rm keeps the relative path; sudo and env wrappers are looked through; -- ends flags", () => {
    expect(shellDeleteTargets("cd client-data/tmp && rm export-scratch.tmp thumbnail-cache.tmp && echo done")).toEqual(["export-scratch.tmp", "thumbnail-cache.tmp"]);
    expect(shellDeleteTargets("sudo rm -f /var/tmp/x.log")).toEqual(["/var/tmp/x.log"]);
    expect(shellDeleteTargets("FOO=1 rm -- -weird-name.md")).toEqual(["-weird-name.md"]);
    expect(shellDeleteTargets("unlink a.md | rm b.md")).toEqual(["a.md", "b.md"]);
  });

  it("keeps a glob as written — a pattern names no file", () => {
    expect(shellDeleteTargets("rm cleanup/*.tmp")).toEqual(["cleanup/*.tmp"]);
  });
});
