import { describe, it, expect } from "vitest";
import { shellCommandWritesFiles } from "./shell-write-detector.js";

// Guards the "don't edit" shell-escape detector. The two halves matter equally:
// it must catch the common ways a shell command mutates the workspace, AND it
// must NOT over-block read-only shell (grep/ls/cat), or a workspace-write ban
// would break legitimate "don't edit, just show me…" requests.
describe("shellCommandWritesFiles", () => {
  it("flags filesystem-mutating commands", () => {
    for (const cmd of [
      "sed -i 's/a/b/' src/x.ts",       // in-place edit
      "echo hello > out.txt",           // redirect create
      "printf '%s' x >> log",           // redirect append
      "cat a b > merged.txt",           // redirect merge
      "cp src/a.ts src/b.ts",           // copy
      "mv old.ts new.ts",               // move
      "rm -rf build",                   // delete
      "tee out.txt",                    // tee write
      "mkdir newdir",                   // create dir
      "touch newfile",                  // create file
      "cat <<'EOF' > f.txt\nhi\nEOF",   // heredoc to file
      "python3 -c \"open('x','w').write('y')\"", // interpreter write
    ]) {
      expect(shellCommandWritesFiles(cmd), cmd).toBe(true);
    }
  });

  it("does NOT flag read-only commands or benign redirects (no over-block)", () => {
    for (const cmd of [
      "grep -rn tailnet src",
      "ls -la",
      "cat src/x.ts",
      "find . -name '*.rm'",   // 'rm' only inside a quoted arg — command-position anchor holds
      "git commit -m 'wip'",   // commits; does not write workspace files
      "git status",
      "echo done > /dev/null", // benign device target
      "run 2>&1",              // fd dup, not a file
      "diff a b",
      "wc -l file",
    ]) {
      expect(shellCommandWritesFiles(cmd), cmd).toBe(false);
    }
  });

  // Regression for the interpreter-write escape: detectScriptWrite only knows a
  // small allowlist of write idioms, so any mutating call outside it — or any
  // indirection — sailed through a workspace-write ban. Fixed by refusing the
  // inline-eval FORM wholesale (detectInlineInterpreterEval): the body is
  // un-analyzable, so under a write ban it counts as write-capable regardless
  // of content.
  describe("inline interpreter eval counts as write-capable (form refusal)", () => {
    it("DENIES python -c os.remove — a delete call outside the write-idiom allowlist", () => {
      expect(shellCommandWritesFiles(`python -c "import os; os.remove('x')"`)).toBe(true);
    });

    it("DENIES node -e fs.rmSync — node delete missed by the writeFile-only patterns", () => {
      expect(shellCommandWritesFiles(`node -e "require('fs').rmSync('x')"`)).toBe(true);
    });

    it("DENIES python -c open(f,'r+') — update mode missed by the 'w'/'a'/'x' pattern", () => {
      expect(shellCommandWritesFiles(`python -c "open('f','r+').write('x')"`)).toBe(true);
    });

    it("DENIES python -c with an indirected mode (m='w'; open(p,m)) — no literal to match", () => {
      expect(shellCommandWritesFiles(`python -c "m='w'; open('p',m)"`)).toBe(true);
    });

    it("DENIES ruby -e File.write — ruby idioms were never in the allowlist", () => {
      expect(shellCommandWritesFiles(`ruby -e "File.write('f','x')"`)).toBe(true);
    });

    it("DENIES even python -c print(1) — the FORM is refused: an inline body can't be verified read-only under a write ban", () => {
      expect(shellCommandWritesFiles(`python -c "print(1)"`)).toBe(true);
    });

    it("still ALLOWS python script.py — a script file is path-guard-visible; only the inline-eval form is refused", () => {
      expect(shellCommandWritesFiles("python script.py")).toBe(false);
    });

    it("no over-block regression on read-only shell from the new arm", () => {
      for (const cmd of [
        "grep -r foo src",
        "git status",
        "ls -la",
        "cat file",
        "echo hi > /dev/null",
        'git commit -m "msg"',
      ]) {
        expect(shellCommandWritesFiles(cmd), cmd).toBe(false);
      }
    });
  });
});
