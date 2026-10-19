// The warning note is read from the kit's real output: run the vendored size
// check on a scratch project with items in its warning band, then parse it.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { structureWarningNote } from "./structure-check-output.js";

const SCRIPT = fileURLToPath(new URL("./kit/check-code-size.mjs", import.meta.url));
let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "lax-structure-note-")); mkdirSync(join(dir, "src")); });
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const run = () => {
  const r = spawnSync(process.execPath, [SCRIPT, "--max-code", "10", "--warn-code", "5", "--max-fn", "5", "--warn-fn", "3"], { cwd: dir, encoding: "utf-8" });
  return { status: r.status, out: r.stdout + r.stderr };
};
const lines = (n: number) => Array.from({ length: n }, (_, i) => `export const v${i} = ${i};`).join("\n") + "\n";

describe("structureWarningNote", () => {
  it("quotes the kit's warning band, largest first, with the design steer", () => {
    writeFileSync(join(dir, "src", "a.ts"), lines(9));
    writeFileSync(join(dir, "src", "b.ts"), "export function b() {\n  one();\n  two();\n}\n");
    const r = run();
    expect(r.status, r.out).toBe(0);
    const note = structureWarningNote(r.out);
    expect(note).toContain("nearing the size cap: src/a.ts: 9 code lines (cap 10); src/b.ts#b: 4 own code lines (cap 5)");
    expect(note).toContain("move that job into a module named after the job");
    expect(note).toContain("comments are free");
  });

  it("is null when nothing is near a cap", () => {
    writeFileSync(join(dir, "src", "a.ts"), lines(2));
    expect(structureWarningNote(run().out)).toBeNull();
  });

  it("caps the items it quotes and points at the map for the rest", () => {
    const out = ["Nearing the size cap (a warning; it never fails):",
      ...Array.from({ length: 8 }, (_, i) => `  src/f${i}.ts: 33${i} code lines (cap 400)`),
      "  When one of these grows, ...", "Code-size check passed (...)"].join("\n");
    const note = structureWarningNote(out)!;
    expect(note).toContain("src/f4.ts");
    expect(note).not.toContain("src/f5.ts");
    expect(note).toContain("and 3 more in docs/codebase-map.md");
  });
});
