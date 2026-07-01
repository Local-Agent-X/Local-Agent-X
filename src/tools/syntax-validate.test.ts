import { describe, it, expect } from "vitest";
import { validateSyntax, checkEditSyntax, syntaxRejectionMessage } from "./syntax-validate.js";

// The write-time ACI gate: an edit may not turn a syntactically-clean file
// broken. These pin the class behaviour — it's agnostic to project/task and
// fires on the parse result of the edit itself, whatever the file.

const ESM_JS = `import { foo } from "./foo.js";\nexport const bar = foo + 1;\n`;
const VALID_TS = `import { foo } from "./foo.js";\nexport const bar: number = foo + 1;\n`;
const BROKEN_TS = `export function a(x: number) { return x + }\n`;
const VALID_JSON = `{ "a": 1, "b": [2, 3] }`;
const BROKEN_JSON = `{ "a": 1, }trailing`;

describe("validateSyntax — parser accuracy", () => {
  it("does NOT false-positive on valid ESM .js (the vm.Script bug)", () => {
    expect(validateSyntax("m.js", ESM_JS)).toBeNull();
    expect(validateSyntax("m.mjs", ESM_JS)).toBeNull();
  });

  it("passes valid TS (import/export/types) and flags broken TS", () => {
    expect(validateSyntax("a.ts", VALID_TS)).toBeNull();
    expect(validateSyntax("a.ts", BROKEN_TS)).toMatch(/TypeScript syntax/i);
  });

  it("passes valid JSON and flags broken JSON", () => {
    expect(validateSyntax("d.json", VALID_JSON)).toBeNull();
    expect(validateSyntax("d.json", BROKEN_JSON)).toMatch(/JSON/i);
  });

  it("labels a broken .js error as JavaScript, not TypeScript", () => {
    expect(validateSyntax("x.js", `const y = ;`)).toMatch(/JavaScript syntax/i);
  });

  it("returns null for file types it does not check (css/html/py)", () => {
    for (const p of ["s.css", "p.html", "z.py"]) {
      expect(validateSyntax(p, "this is (not; valid} anything")).toBeNull();
    }
  });
});

describe("checkEditSyntax — reject only clean → broken", () => {
  it("REJECTS an edit that turns a clean .ts broken", () => {
    const v = checkEditSyntax("a.ts", VALID_TS, BROKEN_TS);
    expect(v.reject).toBe(true);
    expect(v.issue).toMatch(/TypeScript syntax/i);
  });

  it("ALLOWS an edit to an already-broken file (model may be mid-fix)", () => {
    const stillBroken = `export function a(x: number) { return x + + }\n`;
    const v = checkEditSyntax("a.ts", BROKEN_TS, stillBroken);
    expect(v.reject).toBe(false);
    expect(v.issue).toMatch(/TypeScript syntax/i); // still surfaced as a note
  });

  it("ALLOWS an edit that fixes a broken file back to clean", () => {
    const v = checkEditSyntax("a.ts", BROKEN_TS, VALID_TS);
    expect(v.reject).toBe(false);
    expect(v.issue).toBeNull();
  });

  it("ALLOWS a clean → clean edit", () => {
    const v = checkEditSyntax("a.ts", VALID_TS, `export const bar = 2;\n`);
    expect(v.reject).toBe(false);
    expect(v.issue).toBeNull();
  });

  it("REJECTS a brand-new broken .ts (null baseline = clean)", () => {
    const v = checkEditSyntax("new.ts", null, BROKEN_TS);
    expect(v.reject).toBe(true);
  });

  it("ALLOWS a brand-new clean .ts", () => {
    const v = checkEditSyntax("new.ts", null, VALID_TS);
    expect(v.reject).toBe(false);
  });

  it("REJECTS a clean → broken .json", () => {
    expect(checkEditSyntax("c.json", VALID_JSON, BROKEN_JSON).reject).toBe(true);
  });

  it("does NOT hard-reject .js even when broken (may embed JSX) — surfaces a note", () => {
    const v = checkEditSyntax("c.js", `const a = 1;\n`, `const a = ;\n`);
    expect(v.reject).toBe(false);
    expect(v.issue).toMatch(/JavaScript syntax/i);
  });

  it("never rejects an unchecked language", () => {
    expect(checkEditSyntax("s.css", "a{}", "a{ broken").reject).toBe(false);
  });
});

describe("syntaxRejectionMessage", () => {
  it("names the file, includes the parse error, and says the file is unchanged", () => {
    const m = syntaxRejectionMessage("/p/a.ts", "TypeScript syntax errors:\n  L1:40: '}' expected.");
    expect(m).toContain("/p/a.ts");
    expect(m).toMatch(/UNCHANGED/);
    expect(m).toMatch(/'\}' expected/);
  });
});
