// A figures check sized to the deliverable: a share of its figures (or the
// rest, or all), checked in passes of six, three at a time, each with its own
// budget, and one outcome when the last pass ends. A 40-figure deck used to get
// the same 3-7 value spot check as a 5-figure one (owner's call, 2026-11-24).
import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const prevLaxDir = process.env.LAX_DATA_DIR;
const laxDir = realpathSync(mkdtempSync(join(tmpdir(), "lax-figure-run-")));
process.env.LAX_DATA_DIR = laxDir;
mkdirSync(join(laxDir, "sessions"), { recursive: true });
afterAll(() => {
  if (prevLaxDir === undefined) delete process.env.LAX_DATA_DIR;
  else process.env.LAX_DATA_DIR = prevLaxDir;
  rmSync(laxDir, { recursive: true, force: true });
});

const passes = vi.hoisted(() => ({ submitted: [] as Array<{ id: string; deliverables: string[]; figures?: string[] }>, seq: 0 }));
vi.mock("./verification-submit.js", () => ({
  submitVerificationOp: async (input: { deliverables: string[]; figures?: string[] }, beforeStart?: (id: string) => void) => {
    const id = `op_pass_${passes.seq++}`;
    passes.submitted.push({ id, deliverables: input.deliverables, figures: input.figures });
    beforeStart?.(id);
    return true;
  },
}));

const { planFigureCheck, startFigureCheck, figureBatchEnded, settledFigures, _resetFigureCheckRunsForTests } = await import("./figure-check-run.js");
const { figureLedger, recordCheckedFigures } = await import("./figure-check-ledger.js");
const { _resetFigureCheckNotesForTests } = await import("./figure-check-note.js");

/** A markdown deliverable with `n` figures, one per section. */
function report(n: number): string {
  const path = join(laxDir, `report-${passes.seq++}-${n}.md`);
  writeFileSync(path, Array.from({ length: n }, (_, i) => `# Part ${i + 1}\nThe price was ${10 + i}.5¢.\n`).join("\n"));
  return path;
}

/** A pass's final text: every listed figure answered `answer`, or as `per` says. */
function verdictFor(figures: string[], answer = "yes", per: Record<number, string> = {}): string {
  const ns = figures.map((l) => Number(l.match(/^#(\d+)/)![1]));
  const rows = ns.map((n) => `| #${n} | price | x | x | ${per[n] ?? answer} |`);
  const bad = ns.some((n) => (per[n] ?? answer) === "no");
  return [`VERDICT: ${bad ? "DISCREPANCIES" : "CONFIRMED"}`, "| # | value | deliverable says | source says | match? |", "|---|---|---|---|---|", ...rows].join("\n");
}

const parentOp = { id: "op_parent", task: "build the report" } as never;

beforeEach(() => {
  passes.submitted = [];
  _resetFigureCheckRunsForTests();
  _resetFigureCheckNotesForTests();
});

describe("what a check covers", () => {
  it("a routine check covers a share sized to the file; all covers every figure", async () => {
    const path = report(40);
    const routine = await planFigureCheck([path], "routine");
    expect(routine.total).toBe(40);
    expect(routine.batches.flatMap((b) => b.listed)).toHaveLength(16);
    expect(routine.batches.map((b) => b.listed.length)).toEqual([6, 6, 4]);
    const all = await planFigureCheck([path], "all");
    expect(all.batches.flatMap((b) => b.listed)).toHaveLength(40);
  });

  it("after a correction, the routine re-check takes the corrected figure even when the share is already confirmed", async () => {
    const path = report(10);
    const ids = Array.from({ length: 10 }, (_, i) => `s${i + 1}#1`);
    recordCheckedFigures(path, new Map(ids.map((id) => [id, id !== "s4#1"])));
    const plan = await planFigureCheck([path], "routine");
    expect(plan.batches.flatMap((b) => b.listed.map((l) => l.figure.id))).toEqual(["s4#1"]);
  });

  it("the rest skips what was confirmed, and takes a figure that did not match first", async () => {
    const path = report(10);
    recordCheckedFigures(path, new Map([["s1#1", true], ["s2#1", true], ["s3#1", false]]));
    const rest = await planFigureCheck([path], "rest");
    const ids = rest.batches.flatMap((b) => b.listed.map((l) => l.figure.id));
    expect(ids).toHaveLength(8);
    expect(ids[0]).toBe("s3#1");
    expect(ids).not.toContain("s1#1");
  });
});

describe("a run of several passes", () => {
  it("runs three passes at a time and settles once, with how much was covered", async () => {
    const path = report(40);
    expect(await startFigureCheck({ parentOp, sessionId: "s-run", deliverables: [path], scope: "all" })).toBe(true);
    expect(passes.submitted).toHaveLength(3); // of 7
    let outcome: unknown = "pending";
    for (let i = 0; i < 7; i++) {
      const pass = passes.submitted[i];
      outcome = await figureBatchEnded(pass.id, verdictFor(pass.figures!, "yes", i === 2 ? { [Number(pass.figures![0].match(/^#(\d+)/)![1])]: "no" } : {}));
      if (i < 6) expect(outcome).toBe("pending");
    }
    expect(passes.submitted).toHaveLength(7);
    expect(outcome).toEqual(expect.objectContaining({
      verdict: "DISCREPANCIES", checked: 40, mismatched: 1, coverage: { checked: 40, total: 40 },
      discrepantOpId: passes.submitted[2].id, discrepantFiles: [path],
    }));
    const ledger = figureLedger(path);
    expect(ledger.size).toBe(40);
    expect([...ledger.values()].filter((ok) => !ok)).toHaveLength(1);
  });

  it("a figure marked unverified settles nothing, and the note's count says so", async () => {
    const path = report(5);
    await startFigureCheck({ parentOp, sessionId: "s-partial", deliverables: [path] });
    const [pass] = passes.submitted;
    const outcome = await figureBatchEnded(pass.id, verdictFor(pass.figures!, "yes", { 1: "unverified", 2: "unverified" }));
    expect(outcome).toEqual(expect.objectContaining({ verdict: "CONFIRMED", checked: 3, coverage: { checked: 3, total: 5 } }));
  });

  // Live 2026-11-25: a deck a correction had corrupted could not be listed, its
  // one pass could not open it and wrote a table of "unverified" rows, and the
  // note said "Checked 59 figures … they match".
  it("a pass over an unlisted file that could not check it counts nothing and is not a match", async () => {
    const broken = join(laxDir, "broken.pptx");
    writeFileSync(broken, "PK not really a deck");
    await startFigureCheck({ parentOp, sessionId: "s-broken", deliverables: [broken] });
    const [pass] = passes.submitted;
    expect(pass.figures).toBeUndefined();
    const table = ["VERDICT: UNVERIFIABLE", "| value | deliverable says | source says | match? |", "|---|---|---|---|",
      "| wind share | ? | 10.3% | unverified |", "| solar share | ? | 7% | unverified |"].join("\n");
    const outcome = await figureBatchEnded(pass.id, table);
    expect(outcome).toEqual(expect.objectContaining({ verdict: "UNVERIFIABLE", checked: 0, mismatched: 0 }));
  });

  it("an op that is not part of a run is left to its caller", async () => {
    expect(await figureBatchEnded("op_elsewhere", "VERDICT: CONFIRMED")).toBe("not-a-run");
  });
});

describe("reading a pass's table", () => {
  it("by its # column, tolerant of the spellings models use", () => {
    const listed = [1, 2, 3, 4].map((n) => ({ n, path: "p", figure: { id: `f${n}`, where: "", value: "", context: "" } }));
    const table = ["| # | value | a | b | match? |", "|---|", "| #1 | x | 1 | 1 | ✅ |", "| **#2** | x | 1 | 2 | No |", "| 3 | x | 1 | ? | unverified |"].join("\n");
    const settled = settledFigures(table, listed);
    expect([...settled].map(([l, ok]) => [l.n, ok])).toEqual([[1, true], [2, false]]);
  });
});
