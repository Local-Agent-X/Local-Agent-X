import { describe, it, expect } from "vitest";
import { homedir } from "node:os";
import { checkHardcodedHomePath } from "./portable-path-check.js";

// New-file baseline (before = null): every match is "fresh".
const NEW = null;

describe("checkHardcodedHomePath — flags a machine-specific home path in source", () => {
  it("flags a /Users/<name>/ path in a .ts file and prescribes a portable base", () => {
    const note = checkHardcodedHomePath("guard.ts", NEW, `const ROOT = "/Users/dad/project/src";`);
    expect(note).not.toBeNull();
    expect(note).toContain("/Users/dad");
    expect(note).toContain("process.cwd()");
  });

  it("flags a Linux /home/<name>/ path", () => {
    const note = checkHardcodedHomePath("run.sh", NEW, `cd /home/alice/repo && npm test`);
    expect(note).toContain("/home/alice");
  });

  it("flags a Windows C:\\Users\\<name>\\ path (raw and escaped)", () => {
    expect(checkHardcodedHomePath("a.js", NEW, `const p = "C:\\Users\\bob\\app"`)).not.toBeNull();
    expect(checkHardcodedHomePath("b.json", NEW, `{"root":"C:\\\\Users\\\\bob\\\\app"}`)).not.toBeNull();
    expect(checkHardcodedHomePath("c.ts", NEW, `const p = "C:/Users/bob/app"`)).not.toBeNull();
  });

  it("reports multiple distinct paths", () => {
    const note = checkHardcodedHomePath("x.mjs", NEW, `a="/Users/dad/one"; b="/home/eve/two";`);
    expect(note).toContain("/Users/dad");
    expect(note).toContain("/home/eve");
  });
});

describe("checkHardcodedHomePath — does NOT flag the portable / benign forms", () => {
  it("ignores the correct portable primitives", () => {
    const ok = [
      `const r = process.cwd();`,
      `const h = os.homedir();`,
      `const d = new URL(".", import.meta.url);`,
      `const p = path.join(__dirname, "x");`,
      `const p = "~/notes/todo.md";`,
      `const p = process.env.HOME + "/x";`,
      `const p = "$HOME/x";`,
      `const p = "\${HOME}/x";`,
    ];
    for (const src of ok) expect(checkHardcodedHomePath("f.ts", NEW, src)).toBeNull();
  });

  it("ignores URL path segments that merely contain /home/ or /Users/", () => {
    expect(checkHardcodedHomePath("f.ts", NEW, `fetch("https://site.com/home/dashboard")`)).toBeNull();
    expect(checkHardcodedHomePath("f.ts", NEW, `fetch("https://api.example.com/Users/42")`)).toBeNull();
  });

  it("ignores a relative path containing a home-like segment", () => {
    expect(checkHardcodedHomePath("f.ts", NEW, `import x from "./src/home/widget";`)).toBeNull();
  });

  it("ignores placeholder usernames (documentation, not a leak)", () => {
    expect(checkHardcodedHomePath("f.ts", NEW, `// e.g. /Users/username/project`)).toBeNull();
    expect(checkHardcodedHomePath("f.ts", NEW, `// path: /home/user/app`)).toBeNull();
  });

  it("does not fire on non-source files (docs keep intended examples)", () => {
    expect(checkHardcodedHomePath("README.md", NEW, `Install to /Users/dad/tools`)).toBeNull();
    expect(checkHardcodedHomePath("notes.txt", NEW, `see /home/alice/logs`)).toBeNull();
  });
});

describe("checkHardcodedHomePath — delta awareness", () => {
  it("does NOT nag about a home path that already existed before the edit", () => {
    const before = `const LEGACY = "/Users/dad/old";\n`;
    const after = `const LEGACY = "/Users/dad/old";\nconst added = compute();\n`;
    expect(checkHardcodedHomePath("f.ts", before, after)).toBeNull();
  });

  it("flags a home path THIS edit introduces even if the file had others", () => {
    const before = `const LEGACY = "/Users/dad/old";\n`;
    const after = `const LEGACY = "/Users/dad/old";\nconst NEWP = "/Users/dad/fresh";\n`;
    const note = checkHardcodedHomePath("f.ts", before, after);
    expect(note).toContain("/Users/dad/fresh");
    expect(note).not.toContain("/Users/dad/old");
  });
});

describe("checkHardcodedHomePath — this machine's actual home dir (booster)", () => {
  it("flags the running machine's real home dir baked in verbatim", () => {
    const home = homedir();
    const note = checkHardcodedHomePath("f.ts", NEW, `const p = "${home}/scratch";`);
    expect(note).not.toBeNull();
    expect(note).toContain(home);
  });
});
