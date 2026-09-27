/**
 * The read loop (Peter's live session, 2026-09-26): a 632-line file over the
 * per-result cap was spilled and cut mid-file with lines_shown=632; the
 * continuation read ignored its offset and came back whole, cut again; reading
 * the spill copy did the same. Now the cut is at a whole line, says exactly
 * which lines were shown, names the offset that continues, and `read` honors it.
 */
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect } from "vitest";
import { budgetReadResult } from "./read-budget.js";
import { readTool } from "../tools/read-write-tools.js";

const file = (lines: number, width = 40) =>
  Array.from({ length: lines }, (_, i) => `const line${i + 1} = "${"x".repeat(width)}";`).join("\n");

async function read(path: string, args: Record<string, unknown> = {}) {
  return readTool.execute({ path, ...args }) as Promise<{ content: string; metadata?: Record<string, unknown>; isError?: boolean }>;
}

describe("budgetReadResult — a read over the budget", () => {
  const dir = mkdtempSync(join(tmpdir(), "lax-read-budget-"));
  const big = join(dir, "index.ts");
  writeFileSync(big, file(632));

  it("is cut at a whole line, reports the lines it shows, and names the offset that continues", async () => {
    const full = await read(big);
    expect(full.metadata?.lines_shown).toBe(632);
    const cut = budgetReadResult(full as never, 12_000)!;
    expect(cut.content.length).toBeLessThanOrEqual(12_000);
    const shown = cut.metadata?.lines_shown as number;
    expect(shown).toBeGreaterThan(100);
    expect(shown).toBeLessThan(632);
    expect(cut.metadata?.next_offset).toBe(shown + 1);
    expect(cut.content).toContain(`Showing lines 1-${shown} of 632`);
    expect(cut.content).toContain(`offset=${shown + 1}`);
    // The last shown line is whole — no half line before the note.
    const body = cut.content.slice(0, cut.content.indexOf("\n\n[Showing"));
    expect(body.split("\n").at(-1)).toMatch(new RegExp(`^${shown}\\tconst line${shown} = "x+";$`));
  });

  it("following the offsets it names walks the file in order, with no line twice, and ends", async () => {
    const seen: number[] = [];
    let offset = 1;
    for (let pass = 0; pass < 10; pass++) {
      const page = budgetReadResult((await read(big, offset > 1 ? { offset } : {})) as never, 12_000)!;
      for (const m of page.content.matchAll(/^(\d+)\t/gm)) seen.push(Number(m[1]));
      const next = page.metadata?.next_offset as number | undefined;
      if (next === undefined) break;
      expect(next).toBeGreaterThan(offset);
      offset = next;
    }
    expect(seen).toEqual(Array.from({ length: 632 }, (_, i) => i + 1));
  });

  it("under the budget, and for content that is not a numbered read, it steps aside", async () => {
    const small = await read(big, { offset: 600 });
    expect(budgetReadResult(small as never, 50_000)).toBe(small);
    expect(budgetReadResult({ content: "x".repeat(20_000) }, 1_000)).toBeNull();
  });
});

describe("read — a short file ignores limit but honors offset", () => {
  const dir = mkdtempSync(join(tmpdir(), "lax-read-offset-"));
  const f = join(dir, "notes.ts");
  writeFileSync(f, file(50, 5));

  it("limit alone still returns the whole file (no tiny chunks)", async () => {
    const r = await read(f, { limit: 5 });
    expect(r.metadata?.lines_shown).toBe(50);
  });

  it("an offset continues from that line to the end", async () => {
    const r = await read(f, { offset: 41, limit: 2 });
    expect(r.metadata?.lines_shown).toBe(10);
    expect(r.content).toMatch(/^\[Lines 41-50 of 50\]\n41\t/);
  });

  it("an offset past the end still returns the last line rather than nothing", async () => {
    const r = await read(f, { offset: 999 });
    expect(r.metadata?.lines_shown).toBe(1);
  });
});
