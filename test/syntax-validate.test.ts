import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { editTool, writeTool } from "../src/tools/file-tools.js";
import { validateSyntax } from "../src/tools/syntax-validate.js";

let dir: string;

beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "lax-syntax-")); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

describe("validateSyntax — direct", () => {
  it("passes valid JSON", () => {
    expect(validateSyntax("a.json", '{"x":1}')).toBeNull();
  });
  it("catches malformed JSON", () => {
    const r = validateSyntax("a.json", '{"x":1,,}');
    expect(r).toMatch(/JSON parse/);
  });
  it("passes valid JS", () => {
    expect(validateSyntax("a.js", "const x = 1; function f() { return x; }")).toBeNull();
  });
  it("catches JS syntax errors", () => {
    const r = validateSyntax("a.js", "function f( { return 1;");
    expect(r).toMatch(/JavaScript syntax/);
  });
  it("allows top-level await in JS (no false positive)", () => {
    expect(validateSyntax("a.mjs", "const x = await Promise.resolve(1);")).toBeNull();
  });
  it("passes valid TS with types and interfaces", () => {
    expect(validateSyntax("a.ts", "interface I { x: number } const x: I = { x: 1 };")).toBeNull();
  });
  it("catches TS syntax errors", () => {
    const r = validateSyntax("a.ts", "interface I { x: number ;; const x: I = { x: 1 };");
    expect(r).toMatch(/TypeScript syntax/);
  });
  it("passes valid TSX with JSX", () => {
    expect(validateSyntax("a.tsx", "const el = <div className=\"x\">hi</div>;")).toBeNull();
  });
  it("returns null for unknown extensions (HTML/CSS skipped)", () => {
    expect(validateSyntax("a.html", "<<<broken>>>")).toBeNull();
    expect(validateSyntax("a.css", ".x { color: ; }")).toBeNull();
  });
});

describe("write tool — surfaces syntax warning via recovery", () => {
  it("plain ok on valid JS", async () => {
    const r = await writeTool.execute({ path: join(dir, "good.js"), content: "const x = 1;" });
    expect(r.isError).toBeFalsy();
    expect(r.metadata?.recovery).toBeUndefined();
  });
  it("ok + recovery on broken JS (file still written)", async () => {
    const p = join(dir, "broken.js");
    const r = await writeTool.execute({ path: p, content: "function f( { return 1;" });
    expect(r.isError).toBeFalsy();
    expect(String(r.metadata?.recovery || "")).toMatch(/JavaScript syntax/);
    // The broken file IS saved — we want the model to see the warning and fix,
    // not silently roll back what it intended to write.
    expect(r.content).toMatch(/Wrote/);
  });
  it("hard-rejects broken JSON — write refused, file NOT created", async () => {
    const p = join(dir, "x.json");
    const r = await writeTool.execute({ path: p, content: '{"x":1,,}' });
    // A write that would make a clean/new .json file syntactically broken is
    // REFUSED (strictly safer than the old recover-and-save behavior): the file
    // never lands, and the model gets the parse error back to fix and retry.
    expect(r.isError).toBeTruthy();
    expect(r.content).toMatch(/JSON parse/);
    expect(existsSync(p)).toBe(false);
  });
});

describe("edit tool — surfaces syntax warning via recovery", () => {
  it("plain ok when edit produces valid JS", async () => {
    const p = join(dir, "f.js");
    writeFileSync(p, "const x = 1;\n", "utf-8");
    const r = await editTool.execute({ path: p, old_string: "const x = 1;", new_string: "const x = 2;" });
    expect(r.isError).toBeFalsy();
    expect(r.metadata?.recovery).toBeUndefined();
  });
  it("ok + recovery when edit produces broken JS", async () => {
    const p = join(dir, "f.js");
    writeFileSync(p, "const x = 1;\n", "utf-8");
    const r = await editTool.execute({ path: p, old_string: "const x = 1;", new_string: "const x = ;" });
    expect(r.isError).toBeFalsy();
    expect(String(r.metadata?.recovery || "")).toMatch(/JavaScript syntax/);
  });
});
