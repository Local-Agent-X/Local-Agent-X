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

  // Regression for the chained-interpreter escape past 2d3c22cf: that arm split
  // the command on `|` ONLY, so an inline-eval sitting after `;`, `&&`, `||`,
  // `&`, or a newline was never isolated as a command position and slipped the
  // ban. splitShellSegments now splits on every command separator (quote-aware,
  // so a separator LITERAL inside a quoted arg is not a split point).
  describe("chained interpreter eval is refused past a non-pipe separator", () => {
    it("DENIES a `;`-chained python -c", () => {
      expect(shellCommandWritesFiles(`echo hi; python -c "import os; os.remove('x')"`)).toBe(true);
    });

    it("DENIES a `&&`-chained python -c", () => {
      expect(shellCommandWritesFiles(`true && python -c "import os;os.remove('x')"`)).toBe(true);
    });

    it("DENIES a `&&`-chained node -e after a cd", () => {
      expect(shellCommandWritesFiles(`cd src && node -e "require('fs').rmSync('x')"`)).toBe(true);
    });

    it("DENIES a newline-chained python -c", () => {
      expect(shellCommandWritesFiles(`echo hi\npython -c "import os; os.remove('x')"`)).toBe(true);
    });

    it("does NOT split on a separator literal inside a quoted arg", () => {
      for (const cmd of [
        `echo "a; b"`,          // `;` is inside the quoted string — one segment, read-only echo
        `git commit -m "x; y"`, // `;` inside the commit message — still a commit, no workspace write
        "grep -r foo src",
        "ls; pwd",              // two read-only commands, neither is inline-eval
        "cat a.txt && cat b.txt",
      ]) {
        expect(shellCommandWritesFiles(cmd), cmd).toBe(false);
      }
    });
  });

  // Regression for the non-argv0 interpreter escape a skeptic found on the
  // per-segment (argv[0]-only) arm: an interpreter reached through a builtin
  // (`command`), a wrapper (`nice`/`timeout`/`xargs`), an env prefix (`V=1`), a
  // command substitution (`$( )` / backtick), or a subshell/brace group sat in a
  // NON-argv0 slot and slipped the write ban. commandHasInlineInterpreterEval
  // scans the whole command (quote-aware, reusing INTERP_EVAL_FLAGS) so the
  // interpreter+eval-flag pair is refused wherever it hides.
  describe("inline interpreter eval is refused in a NON-argv0 position", () => {
    it("DENIES the `command` builtin prefix", () => {
      expect(shellCommandWritesFiles(`command python -c "import os;os.remove('x')"`)).toBe(true);
    });

    it("DENIES a `nice` wrapper", () => {
      expect(shellCommandWritesFiles(`nice python -c "open('f','w')"`)).toBe(true);
    });

    it("DENIES a `timeout` wrapper", () => {
      expect(shellCommandWritesFiles(`timeout 5 python -c "open('f','w')"`)).toBe(true);
    });

    it("DENIES an `xargs` wrapper", () => {
      expect(shellCommandWritesFiles(`xargs python -c "open('f','w')"`)).toBe(true);
    });

    it("DENIES an env-var prefix", () => {
      expect(shellCommandWritesFiles(`V=1 python -c "open('f','w')"`)).toBe(true);
    });

    it("DENIES a `$( )` command substitution assignment", () => {
      expect(shellCommandWritesFiles(`x=$(python -c "open('f','w')")`)).toBe(true);
    });

    it("DENIES a `$( )` command substitution inside an echo", () => {
      expect(shellCommandWritesFiles(`echo $(node -e "require('fs').rmSync('x')")`)).toBe(true);
    });

    it("DENIES a backtick command substitution", () => {
      expect(shellCommandWritesFiles("x=`python -c \"open('f','w')\"`")).toBe(true);
    });

    it("DENIES a subshell", () => {
      expect(shellCommandWritesFiles(`(python -c "open('f','w')")`)).toBe(true);
    });

    it("DENIES a brace group", () => {
      expect(shellCommandWritesFiles(`{ python -c "open('f','w')"; }`)).toBe(true);
    });

    it("does NOT over-block a quoted interpreter literal or a real script run", () => {
      for (const cmd of [
        `echo "python -c foo"`,            // interpreter is inside a quoted literal
        "python script.py",                // real script file, no eval flag
        `grep -r "node -e" src`,           // 'node -e' is a quoted search pattern
        "ls; pwd",                         // two read-only commands
        `git commit -m "run python -c later"`, // interpreter named in a quoted message
      ]) {
        expect(shellCommandWritesFiles(cmd), cmd).toBe(false);
      }
    });
  });

  // Regression for the python-spelling gap past 2d3c22cf: the INTERP_EVAL_FLAGS
  // table is keyed on "python"/"python3", so `pythonw`/`python2`/`python3.12`/
  // `python.exe` bypassed the form refusal. execBasename now collapses the whole
  // python family to "python" so every spelling matches.
  describe("python-family spellings all hit the inline-eval form refusal", () => {
    it("DENIES pythonw -c", () => {
      expect(shellCommandWritesFiles(`pythonw -c "open('f','w')"`)).toBe(true);
    });

    it("DENIES python3.12 -c", () => {
      expect(shellCommandWritesFiles(`python3.12 -c "open('f','w')"`)).toBe(true);
    });
  });
});
