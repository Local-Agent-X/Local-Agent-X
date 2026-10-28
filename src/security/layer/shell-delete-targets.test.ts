import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { leadingRun, shellDeletes, shellDeleteTargets } from "./shell-delete-targets.js";

describe("a backslash path is the path written", () => {
  it("del with a Windows path under the same rule as rm with a POSIX one", () => {
    expect(shellDeleteTargets(`del "client-data\\tmp\\thumbnail-cache.tmp"`)).toEqual(["client-data\\tmp\\thumbnail-cache.tmp"]);
  });

  // Audit 2026-10-27: a private tokenizer read the backslashes as escapes and
  // the card named "C:Tempx.tmp", a file that does not exist.
  it("an unquoted Windows path keeps its backslashes", () => {
    expect(shellDeleteTargets(`del C:\\Temp\\x.tmp`)).toEqual(["C:\\Temp\\x.tmp"]);
    expect(shellDeleteTargets(`Remove-Item C:\\Users\\me\\notes.md`)).toEqual(["C:\\Users\\me\\notes.md"]);
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

  it("a PowerShell parameter's value is not a path — found live: `-ErrorAction Stop` read as a file called Stop", () => {
    expect(shellDeleteTargets(`Remove-Item "client-data/tmp/thumbnail-cache.tmp" -ErrorAction Stop`)).toEqual(["client-data/tmp/thumbnail-cache.tmp"]);
    expect(shellDeleteTargets(`Remove-Item -Path a.md -Force -Confirm:$false -ErrorAction SilentlyContinue`)).toEqual(["a.md"]);
    expect(shellDeleteTargets(`Remove-Item a.md -Filter *.tmp -Exclude keep.md -Force`)).toEqual(["a.md"]);
    expect(shellDeleteTargets(`Remove-Item -Force -Path b.md`)).toEqual(["b.md"]);
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

  // Audit 2026-10-27: the splitter cut inside the quoted message and carded
  // users.csv for a commit.
  it("a delete spelled inside a quoted argument is text, not a command", () => {
    expect(shellDeleteTargets(`git commit -m "fix; rm -f users.csv"`)).toEqual([]);
    expect(shellDeleteTargets(`echo "a && rm users.csv"`)).toEqual([]);
  });

  it("cd then rm keeps the relative path; sudo and env wrappers are looked through; -- ends flags", () => {
    expect(shellDeleteTargets("cd client-data/tmp && rm export-scratch.tmp thumbnail-cache.tmp && echo done")).toEqual(["export-scratch.tmp", "thumbnail-cache.tmp"]);
    expect(shellDeleteTargets("sudo rm -f /var/tmp/x.log")).toEqual(["/var/tmp/x.log"]);
    expect(shellDeleteTargets("FOO=1 rm -- -weird-name.md")).toEqual(["-weird-name.md"]);
    expect(shellDeleteTargets("unlink a.md | rm b.md")).toEqual(["a.md", "b.md"]);
  });

  // Audit 2026-10-27: each of these deleted users.csv with no card, because
  // the private walk looked through sudo/command/env and nothing else.
  it("every wrapper the shell rules see through, and a shell's -c body", () => {
    for (const command of [
      `bash -c "rm -f users.csv"`, "timeout 5 rm users.csv", "nohup rm users.csv", "nice -n 5 rm users.csv",
      `sh -lc 'rm users.csv'`, `cmd /c del users.csv`, `env -u X command rm users.csv`, "shred -u users.csv",
    ]) expect(shellDeleteTargets(command), command).toEqual(["users.csv"]);
  });

  it("keeps a glob as written — a pattern names no file", () => {
    expect(shellDeleteTargets("rm cleanup/*.tmp")).toEqual(["cleanup/*.tmp"]);
  });

  // TB2 compile-compcert, 2026-10-24: the card listed `2>/dev/null` as a file.
  it("a redirection is not a target", () => {
    expect(shellDeleteTargets("rm -f cparser/Parser*.ml 2>/dev/null; make")).toEqual(["cparser/Parser*.ml"]);
    expect(shellDeleteTargets("rm -f a.log > /dev/null 2>&1")).toEqual(["a.log"]);
    expect(shellDeleteTargets("rm -f a.log 2> err.txt")).toEqual(["a.log"]);
  });
});

describe("shellDeletes — every delete, its form, and where it runs", () => {
  const base = resolve("/ws");
  const one = (command: string) => shellDeletes(command, base);

  it("names the form, whether it is recursive, and its targets", () => {
    expect(one("rm -rf a b").map(({ verb, recursive, forced, targets }) => ({ verb, recursive, forced, targets })))
      .toEqual([{ verb: "rm", recursive: true, forced: true, targets: ["a", "b"] }]);
    expect(one("Remove-Item -Recurse C:\\x")[0]).toMatchObject({ verb: "remove-item", recursive: true, targets: ["C:\\x"] });
    expect(one("rm -Recurse -Force build")[0]).toMatchObject({ verb: "remove-item", recursive: true, forced: true });
    expect(one("rd /s /q C:\\x")[0]).toMatchObject({ verb: "rd", recursive: true, targets: ["C:\\x"] });
    expect(one("rmdir empty")[0]).toMatchObject({ verb: "rmdir", recursive: false });
    expect(one("del /f a.tmp")[0]).toMatchObject({ verb: "del", recursive: false, forced: true, targets: ["a.tmp"] });
    expect(one("shred -n 3 -u secret.txt")[0]).toMatchObject({ verb: "shred", targets: ["secret.txt"] });
  });

  it("a wrapper or a shell body marks the delete wrapped, and so does an assignment", () => {
    expect(one("rm a")[0].wrapped).toBe(false);
    expect(one("PATH=/x rm a")[0].wrapped).toBe(true);
    expect(one("sudo rm a")[0].wrapped).toBe(true);
    expect(one(`bash -c "rm a"`)[0].wrapped).toBe(true);
  });

  it("resolves the folder a delete runs in past a cd it can place, and gives up on one it cannot", () => {
    expect(one("rm a")[0].cwd).toBe(base);
    expect(one("cd ./out && rm a")[0].cwd).toBe(resolve(base, "out"));
    expect(one(`cd ${resolve("/elsewhere")} && rm a`)[0].cwd).toBe(resolve("/elsewhere"));
    expect(one("cd out && rm a")[0].cwd).toBeNull();          // CDPATH can send a bare name anywhere
    expect(one("cd ./out; rm a")[0].cwd).toBeNull();          // a failed cd still runs rm
    expect(one("Set-Location ./out; rm a")[0].cwd).toBeNull();
    expect(one("pushd ./out && popd && rm a")[0].cwd).toBeNull();
    expect(one("rm a && cd ./out")[0].cwd).toBe(base);        // a later cd moves nothing before it
    expect(one(`bash -c "cd ./out && ls" && rm a`)[0].cwd).toBe(base); // a body's cd stays in the body
    expect(one(`bash -c "cd ./out && rm a"`)[0].cwd).toBe(resolve(base, "out"));
  });
});

describe("leadingRun — what runs before anything else", () => {
  const isRm = (s: string) => s.trim().startsWith("rm ");
  it("is the deletes that open the command, and null when a pipe or & joins them", () => {
    expect(leadingRun("rm -rf a && rm b; make", isRm)).toEqual(["rm -rf a", "rm b"]);
    expect(leadingRun("rm a & mv x a", isRm)).toBeNull();
    expect(leadingRun("rm a | tee log", isRm)).toBeNull();
    expect(leadingRun("rm a && make 2>&1 | tail", isRm)).toEqual(["rm a"]);
    expect(leadingRun("mv x a && rm a", isRm)).toEqual([]);
  });

  it("a separator inside quotes splits nothing", () => {
    expect(leadingRun(`rm "a; b" && make`, isRm)).toEqual([`rm "a; b"`]);
  });
});
