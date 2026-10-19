// The kit's size check (kit/check-code-size.mjs) and its ratchet: an item
// over a cap fails unless the ratchet lists it at its recorded size, a listed
// item may only shrink, a shrink must be locked in, and an item back under the
// cap leaves the list. The warning band never fails. Small caps keep the
// fixtures short; the rule is the same at any size.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT = fileURLToPath(new URL("./kit/check-code-size.mjs", import.meta.url));
const CAPS = ["--max-code", "10", "--warn-code", "6", "--max-fn", "5", "--warn-fn", "3"];

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "lax-size-ratchet-")); });
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const file = (rel: string, text: string) => {
  mkdirSync(dirname(join(dir, rel)), { recursive: true });
  writeFileSync(join(dir, rel), text);
};
const lines = (n: number, prefix = "v") => Array.from({ length: n }, (_, i) => `export const ${prefix}${i} = ${i};`).join("\n") + "\n";
const fnOf = (name: string, n: number) => `export function ${name}() {\n${Array.from({ length: n }, (_, i) => `  use(${i});`).join("\n")}\n}\n`;
const ratchet = () => readFileSync(join(dir, ".code-size-ratchet"), "utf-8");
function run(...extra: string[]) {
  const r = spawnSync(process.execPath, [SCRIPT, ...CAPS, ...extra], { cwd: dir, encoding: "utf-8" });
  return { status: r.status, out: (r.stdout ?? "") + (r.stderr ?? "") };
}

describe("check-code-size: caps and the warning band", () => {
  it("a new file or function over its cap fails with the steering message", () => {
    file("src/a.ts", lines(11));
    file("src/b.ts", fnOf("big", 4));
    const r = run();
    expect(r.status).toBe(1);
    expect(r.out).toContain("src/a.ts: 11 code lines (cap 10)");
    expect(r.out).toContain("src/b.ts#big: 6 own code lines (cap 5)");
    expect(r.out).toContain("move that job into a module (or function) named after the job");
    expect(r.out).toContain("never delete comments to fit, and never name the split after the limit");
  });

  it("the warning band lists items and never fails; comments are free", () => {
    file("src/a.ts", "// note\n".repeat(50) + lines(8));
    file("src/b.ts", fnOf("mid", 2));
    const r = run();
    expect(r.status, r.out).toBe(0);
    expect(r.out).toContain("Nearing the size cap (a warning; it never fails):");
    expect(r.out).toContain("src/a.ts: 8 code lines (cap 10)");
    expect(r.out).toContain("src/b.ts#mid: 4 own code lines (cap 5)");
  });

  it("test files are not measured", () => {
    file("src/a.test.ts", lines(50));
    expect(run().status).toBe(0);
  });
});

describe("check-code-size: the ratchet", () => {
  beforeEach(() => {
    file("src/a.ts", lines(14));
    file("src/b.ts", fnOf("big", 7));
  });

  it("--write-ratchet records what is over a cap, sorted, the same every time; the check then passes", () => {
    expect(run("--write-ratchet").status).toBe(0);
    const first = ratchet();
    expect(first.split("\n").filter((l) => l && !l.startsWith("#"))).toEqual(["src/a.ts 14", "src/b.ts#big 9"]);
    run("--write-ratchet");
    expect(ratchet()).toBe(first);
    expect(run().status).toBe(0);
  });

  it("a listed item that grew fails", () => {
    run("--write-ratchet");
    file("src/a.ts", lines(15));
    const r = run();
    expect(r.status).toBe(1);
    expect(r.out).toContain("src/a.ts: 15 code lines (cap 10), recorded at 14 in the ratchet");
  });

  it("a listed item that shrank fails until the ratchet is lowered, and prints the command that lowers it", () => {
    run("--write-ratchet");
    file("src/a.ts", lines(12));
    const r = run("--ratchet", ".code-size-ratchet");
    expect(r.status).toBe(1);
    expect(r.out).toContain("src/a.ts: 12, recorded at 14");
    expect(r.out).toMatch(/Run: node \S*check-code-size\.mjs --max-code 10 .*--ratchet \.code-size-ratchet --tighten/);
    expect(run("--tighten").status).toBe(0);
    expect(ratchet()).toContain("src/a.ts 12\n");
  });

  it("an item back under the cap and still listed fails; --tighten removes it", () => {
    run("--write-ratchet");
    file("src/b.ts", fnOf("big", 2));
    const r = run("--self", "npm run check:size --");
    expect(r.status).toBe(1);
    expect(r.out).toContain("src/b.ts#big");
    expect(r.out).toContain("run: npm run check:size -- --tighten");
    expect(run("--tighten").status).toBe(0);
    expect(ratchet()).not.toContain("src/b.ts#big");
  });

  it("an item not in the ratchet fails even when others are listed", () => {
    run("--write-ratchet");
    file("src/c.ts", lines(11, "c"));
    const r = run();
    expect(r.status).toBe(1);
    expect(r.out).toContain("Over the size cap:\n  src/c.ts: 11 code lines (cap 10)");
  });

  it("a duplicate-named function whose line moved still matches its entry", () => {
    file("src/d.ts", `app.on("a", () => {\n${"  one();\n".repeat(6)}});\napp.on("b", () => {\n${"  two();\n".repeat(6)}});\n`);
    run("--write-ratchet");
    expect(ratchet()).toContain("src/d.ts#app.on:callback@1 8");
    file("src/d.ts", `\n\n// both callbacks move down three lines\n${readFileSync(join(dir, "src/d.ts"), "utf-8")}`);
    const r = run();
    expect(r.status, r.out).toBe(0);
  });
});
