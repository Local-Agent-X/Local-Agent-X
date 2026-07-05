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
});
