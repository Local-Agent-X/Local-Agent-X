import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { editTool } from "./edit-tools.js";
import { writeTool } from "./read-write-tools.js";


// End-to-end through the REAL edit/write tools: the write-time syntax gate must
// reject an edit that turns a clean file broken AND leave the file byte-for-byte
// unchanged on disk — the guarantee unit tests on checkEditSyntax can't give
// (they never touch the filesystem). Absolute temp paths, no model, no mocks.

let dir: string;
const CLEAN_TS = `export function add(a: number, b: number): number {\n  return a + b;\n}\n`;

beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "lax-edit-")); });
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("editTool — write-time syntax gate", () => {
  it("REJECTS an edit that breaks a clean .ts and leaves the file UNCHANGED", async () => {
    const file = join(dir, "math.ts");
    writeFileSync(file, CLEAN_TS);
    const r = await editTool.execute({
      path: file,
      old_string: "return a + b;",
      new_string: "return a + ;", // syntax error
    });
    expect(r.isError).toBe(true);
    expect(String(r.content)).toMatch(/NOT applied|syntax/i);
    // The whole point: disk content is untouched.
    expect(readFileSync(file, "utf-8")).toBe(CLEAN_TS);
  });

  it("ALLOWS a valid edit and writes it", async () => {
    const file = join(dir, "math.ts");
    writeFileSync(file, CLEAN_TS);
    const r = await editTool.execute({
      path: file,
      old_string: "return a + b;",
      new_string: "return a - b;",
    });
    expect(r.isError).toBeFalsy();
    expect(readFileSync(file, "utf-8")).toContain("return a - b;");
  });

  it("ALLOWS an edit to an ALREADY-broken file (model may be mid-fix)", async () => {
    const file = join(dir, "broken.ts");
    const broken = `export function add(a: number) { return a + }\n`;
    writeFileSync(file, broken);
    const r = await editTool.execute({
      path: file,
      old_string: "return a + }",
      new_string: "return a + b }", // still broken, but no worse-from-clean
    });
    expect(r.isError).toBeFalsy();
    expect(readFileSync(file, "utf-8")).toContain("return a + b }");
  });
});

describe("writeTool — write-time syntax gate", () => {
  it("REJECTS creating a brand-new broken .ts (nothing written)", async () => {
    const file = join(dir, "new.ts");
    const r = await writeTool.execute({ path: file, content: `export const x = ;\n` });
    expect(r.isError).toBe(true);
    // File must not have been created.
    let exists = true;
    try { readFileSync(file, "utf-8"); } catch { exists = false; }
    expect(exists).toBe(false);
  });

  it("ALLOWS creating a clean new .ts", async () => {
    const file = join(dir, "ok.ts");
    const r = await writeTool.execute({ path: file, content: CLEAN_TS });
    expect(r.isError).toBeFalsy();
    expect(readFileSync(file, "utf-8")).toBe(CLEAN_TS);
  });
});

// A machine-specific home path is a NON-FATAL portability nudge, not a reject:
// the file must still land (an absolute home path can be intentional), and the
// model must get a recovery note pointing at process.cwd()/os.homedir(). This is
// the "works on my machine" class (a guard hardcoding ROOT="/Users/dad/…").
describe("write-time portability nudge (non-fatal)", () => {
  it("writeTool LANDS a new .ts with a hardcoded home path AND returns a portability note", async () => {
    const file = join(dir, "guard.ts");
    const content = `const ROOT = "/Users/dad/lais-eval/project";\nexport const root = ROOT;\n`;
    const r = await writeTool.execute({ path: file, content });
    expect(r.isError).toBeFalsy();                             // NOT rejected
    expect(readFileSync(file, "utf-8")).toBe(content);         // file landed intact
    expect(String(r.metadata?.recovery)).toMatch(/portability/i);
    expect(String(r.metadata?.recovery)).toContain("process.cwd()");
  });

  it("editTool LANDS an edit that introduces a home path AND notes it", async () => {
    const file = join(dir, "cfg.ts");
    writeFileSync(file, `export const root = compute();\n`);
    const r = await editTool.execute({
      path: file,
      old_string: "compute()",
      new_string: `"/home/alice/repo"`,
    });
    expect(r.isError).toBeFalsy();
    expect(readFileSync(file, "utf-8")).toContain("/home/alice/repo");
    expect(String(r.metadata?.recovery)).toContain("/home/alice/repo");
  });

  it("does NOT note a clean portable write", async () => {
    const file = join(dir, "clean.ts");
    const r = await writeTool.execute({ path: file, content: `const root = process.cwd();\n` });
    expect(r.isError).toBeFalsy();
    expect(r.metadata?.recovery).toBeUndefined();
  });
});
