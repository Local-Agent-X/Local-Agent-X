// The chunk skeptic: its verdict parse (default to broken), its process-failure
// direction (not-run, never broken), and what its brief hands it.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { FINISH_FIX_BREAK_GROUNDS, SKEPTIC_BAR_BLOCK, SKEPTIC_BREAK_GROUNDS, SKEPTIC_RULE_REACH, finishFixLeavesAppNoWorse } from "./skeptic-bar.js";

const agent = vi.hoisted(() => ({
  result: { stdout: "", exitCode: 0, durationMs: 1 } as { stdout: string; exitCode: number; durationMs: number; error?: string },
  /** Answers for successive calls, before `result` takes over. */
  queue: [] as Array<{ stdout: string; exitCode: number; durationMs: number; error?: string }>,
  calls: [] as Array<{ role: string; task: string; projectDir?: string }>,
  /** What the skeptic does in the project while it runs (writes a probe). */
  during: undefined as ((projectDir: string) => void) | undefined,
}));

vi.mock("../agents/chunk-runner.js", () => ({
  SKEPTIC_PROBE_DIR: ".skeptic",
  runChunkAgent: vi.fn(async (opts: { role: string; task: string; projectDir?: string }) => {
    agent.calls.push(opts);
    agent.during?.(opts.projectDir!);
    return agent.queue.shift() ?? agent.result;
  }),
}));

const { buildSkepticTask, parseSkepticVerdict, runChunkSkeptic } = await import("./skeptic.js");
const { parsePlanText } = await import("../plan-parser.js");

const chunk = parsePlanText([
  "# Plan",
  "## Phase A — Core",
  "### Chunk 3 — Booking",
  "- **Class:** trunk → `/senior-engineer`",
  "- **Slice:** a visitor books a slot.",
  "- **Depends on:** —",
  "- **Scenarios:** 2",
  "- **Done when:** a booked slot disappears from the list.",
].join("\n")).chunks[0];

beforeEach(() => {
  agent.calls.length = 0;
  agent.queue.length = 0;
  agent.result = { stdout: "", exitCode: 0, durationMs: 1 };
});

describe("parseSkepticVerdict", () => {
  it("reads HOLDS and BROKEN with their findings", () => {
    expect(parseSkepticVerdict("I ran the tests.\nVERDICT: HOLDS\nFINDING: tried DST and empty input.")).toEqual({
      status: "holds", finding: "tried DST and empty input.",
    });
    const broken = parseSkepticVerdict("VERDICT: BROKEN\nFINDING: booking twice double-books (src/book.ts:41);\nshown by a two-request probe.");
    expect(broken.status).toBe("broken");
    expect(broken.finding).toContain("src/book.ts:41");
    expect(broken.finding).toContain("two-request probe");
  });

  it("takes the last verdict line, so a quoted format does not decide it", () => {
    const raw = "The format is VERDICT: BROKEN | HOLDS.\nVERDICT: HOLDS\nFINDING: survived.";
    expect(parseSkepticVerdict(raw).status).toBe("holds");
  });

  it("tolerates bold markers and lower case", () => {
    expect(parseSkepticVerdict("**VERDICT:** broken\n**FINDING:** x").status).toBe("broken");
  });

  it("a BROKEN finding leads with the ground it names", () => {
    const v = parseSkepticVerdict([
      "VERDICT: BROKEN",
      'GROUND: spec/plan.md, chunk 3 done-when: "a booked slot disappears from the list"',
      "FINDING: the slot is still listed after booking (src/book.ts:41); shown by a probe.",
      "FOLLOW_UPS: none",
    ].join("\n"));
    expect(v.status).toBe("broken");
    expect(v.finding).toBe(
      'Breaks: spec/plan.md, chunk 3 done-when: "a booked slot disappears from the list"\n' +
      "the slot is still listed after booking (src/book.ts:41); shown by a probe.",
    );
    expect(v.followUps).toBeUndefined();
  });

  // What the skeptic found beyond the contract is listed apart from the
  // finding, so it can be recorded without holding the chunk back.
  it("reads follow-ups apart from the finding, on HOLDS and on BROKEN", () => {
    const holds = parseSkepticVerdict([
      "VERDICT: HOLDS",
      "FINDING: tried double booking, DST and an empty name.",
      "FOLLOW_UPS:",
      "- a slot name of 300 characters overflows the row; the spec names no length.",
      "- no test for a slot booked at midnight.",
    ].join("\n"));
    expect(holds).toEqual({
      status: "holds",
      finding: "tried double booking, DST and an empty name.",
      followUps: [
        "a slot name of 300 characters overflows the row; the spec names no length.",
        "no test for a slot booked at midnight.",
      ],
    });
    const broken = parseSkepticVerdict("VERDICT: BROKEN\nGROUND: crash\nFINDING: throws on an empty list.\n**FOLLOW-UPS:** - long names overflow");
    expect(broken.finding).toBe("Breaks: crash\nthrows on an empty list.");
    expect(broken.followUps).toEqual(["long names overflow"]);
  });

  it("no verdict line is broken: it has not shown the change holds", () => {
    const v = parseSkepticVerdict("Looks fine to me overall.");
    expect(v.status).toBe("broken");
    expect(v.finding).toContain("no VERDICT line");
    expect(v.finding).toContain("Looks fine");
  });
});

describe("buildSkepticTask", () => {
  it("carries the contract, the claim and the sha the diff starts from", () => {
    const task = buildSkepticTask({ chunk, rawReport: "STATUS: done\nNOTE: all good", preSha: "abc1234" });
    expect(task).toContain("a visitor books a slot");
    expect(task).toContain("a booked slot disappears from the list");
    expect(task).toContain("STATUS: done");
    expect(task).toContain("git diff abc1234");
    expect(task).toMatch(/Prove it wrong/);
    expect(task).toMatch(/beyond the contract is a follow-up, not a break/);
  });
});

// A finish fix's skeptic checks the fix, not the whole app: re-attacking the
// whole app after every fix round cost label-check-sol two hours per fix chunk
// on problems that were there before the fix (2026-11-25).
describe("buildSkepticTask for a finish fix", () => {
  const splitHeading = (heading: string) => parsePlanText([
    "# Plan", `## ${heading}`, "### Chunk 101201 — Stalled native write",
    "- **Class:** trunk", "- **Slice:** recover from a stalled write.", "- **Depends on:** 1012",
    "- **Scenarios:** —", "- **Done when:** a stalled write is reported.",
  ].join("\n")).chunks[0];

  it("gives a chunk the finish gates wrote, and a part split off one, the finish-fix bar", async () => {
    const { fixChunksFor } = await import("../finish-gates/run.js");
    const [fix] = fixChunksFor(1, { failed: [], unjudged: [] }, [
      { persona: "unlucky", status: "ran", findings: [{ severity: "high", text: "a cancelled edit overwrites the saved medication" }] },
    ] as never);
    for (const c of [fix, splitHeading("Split from chunk 1012 — Finish fix 1: unlucky findings")]) {
      const task = buildSkepticTask({ chunk: c, rawReport: "STATUS: done", preSha: "abc1234" });
      expect(task).toContain("## This is a finish fix");
      for (const ground of FINISH_FIX_BREAK_GROUNDS) expect(task).toContain(ground);
      expect(task).toMatch(/already in the app before this chunk/);
      expect(task).toMatch(/Prove it wrong by the finish-fix bar/);
      expect(task).not.toMatch(/Prove it wrong against the contract above and the project's/);
    }
  });

  it("leaves a plan chunk, and a plan chunk's split part numbered past 1000, on the contract bar", () => {
    for (const c of [chunk, splitHeading("Split from chunk 10 — Native scan")]) {
      const task = buildSkepticTask({ chunk: c, rawReport: "STATUS: done", preSha: "abc1234" });
      expect(task).not.toContain("## This is a finish fix");
      expect(task).toMatch(/Prove it wrong against the contract above/);
    }
  });

  it("a crash, lost data or a security hole still holds a finish fix back", () => {
    expect(FINISH_FIX_BREAK_GROUNDS).toContain(SKEPTIC_BREAK_GROUNDS[1]);
  });

  // A fix out of rounds lands what it fixed only when what is left cannot have
  // made the app worse (loop/handle-push-back.ts); the number says which.
  it("asks the ground's number, keeps it on the verdict, and reads 1 and 2 as no worse", () => {
    const task = buildSkepticTask({ chunk: { ...chunk, number: 1012, phase: "Finish" }, rawReport: "STATUS: done", preSha: "abc" });
    expect(task).toContain(`1. ${FINISH_FIX_BREAK_GROUNDS[0]}`);
    expect(task).toContain("start the GROUND line with the number");
    const v = parseSkepticVerdict("VERDICT: BROKEN\nGROUND: 2 — its test passes without the fix\nFINDING: x");
    expect(v.ground).toBe("2 — its test passes without the fix");
    expect(finishFixLeavesAppNoWorse(parseSkepticVerdict("VERDICT: BROKEN\nGROUND: **1** — still reproduces").ground)).toBe(true);
    expect([v.ground, "1 — still reproduces", "3 — broke saving", "4 — loses data", "the fix is incomplete", undefined].map(finishFixLeavesAppNoWorse))
      .toEqual([true, true, false, false, false, false]);
  });
});

// The bar is the /greenfield skill's (references/autonomous.md, section 6). The
// engine states it in its own prompt, so the two are pinned to each other: the
// skill the app ships must still name every ground the skeptic is given.
describe("the skeptic's bar", () => {
  const flat = (text: string): string => text.replace(/\s+/g, " ");
  const skill = flat(readFileSync(
    fileURLToPath(new URL("../../protocols/bundled/greenfield/references/autonomous.md", import.meta.url)), "utf-8",
  ));

  it("gives the skeptic the skill's grounds, word for word", () => {
    expect(SKEPTIC_BREAK_GROUNDS.length).toBeGreaterThan(0);
    for (const ground of SKEPTIC_BREAK_GROUNDS) {
      expect(skill).toContain(ground);
      expect(flat(SKEPTIC_BAR_BLOCK)).toContain(ground);
    }
  });

  it("both say that anything beyond the contract is a follow-up, and which way doubt goes", () => {
    expect(skill).toMatch(/is a \*\*follow-up\*\*/);
    expect(skill).toMatch(/Unsure whether the contract covers the case at all: follow-up/);
    expect(SKEPTIC_BAR_BLOCK).toMatch(/is a FOLLOW-UP, not a break/);
    expect(SKEPTIC_BAR_BLOCK).toMatch(/Unsure whether the contract covers the case at all: FOLLOW-UP/);
  });

  // A rule over open-ended input is quotable for any odd input, so how far it
  // reaches is the plan's to mark and the skeptic's to read, in the same words.
  it("reads a rule's reach the way the skill marks it: strict, scoped, and scoped when unmarked", () => {
    expect(SKEPTIC_RULE_REACH).toHaveLength(4);
    for (const sentence of SKEPTIC_RULE_REACH) {
      expect(skill).toContain(sentence);
      expect(flat(SKEPTIC_BAR_BLOCK)).toContain(sentence);
    }
    const planning = flat(readFileSync(
      fileURLToPath(new URL("../../protocols/bundled/greenfield/references/spec.md", import.meta.url)), "utf-8",
    ));
    expect(planning).toMatch(/mark it `\(strict\)` or `\(scoped\)`/);
    expect(planning).toContain("A rule that is not marked is scoped.");
  });
});

describe("runChunkSkeptic", () => {
  it("runs the chunk-skeptic role in the chunk's tree and parses its answer", async () => {
    agent.result = { stdout: "VERDICT: BROKEN\nFINDING: empty name accepted.", exitCode: 0, durationMs: 1 };
    const v = await runChunkSkeptic({ chunk, rawReport: "STATUS: done", preSha: "abc", projectDir: "/proj/wt" });
    expect(v).toEqual({ status: "broken", finding: "empty name accepted." });
    expect(agent.calls[0].role).toBe("chunk-skeptic");
    expect(agent.calls[0].projectDir).toBe("/proj/wt");
  });

  it("a skeptic that never answered is not-run, not broken", async () => {
    agent.result = { stdout: "", exitCode: 124, durationMs: 1, error: "timed out" };
    const v = await runChunkSkeptic({ chunk, rawReport: "", preSha: "abc", projectDir: "/proj" });
    expect(v.status).toBe("not-run");
    expect(v.finding).toContain("timed out");
    expect(agent.calls).toHaveLength(2);
  });

  // 2026-11-25: the skeptic's model stream died after a few reads and its turn
  // ended with nothing said; read as BROKEN, it cost a fix round on nothing.
  it("a turn that ended without a word is not-run, and the skeptic is asked again", async () => {
    agent.queue.push({ stdout: "  \n", exitCode: 0, durationMs: 1 });
    agent.result = { stdout: "VERDICT: HOLDS\nFINDING: ran the probes.", exitCode: 0, durationMs: 1 };
    const v = await runChunkSkeptic({ chunk, rawReport: "", preSha: "abc", projectDir: "/proj" });
    expect(v).toEqual({ status: "holds", finding: "ran the probes." });
    expect(agent.calls).toHaveLength(2);
  });

  it("an answer without a verdict line is still broken, and not asked again", async () => {
    agent.result = { stdout: "I looked around and it seems fine.", exitCode: 0, durationMs: 1 };
    const v = await runChunkSkeptic({ chunk, rawReport: "", preSha: "abc", projectDir: "/proj" });
    expect(v.status).toBe("broken");
    expect(agent.calls).toHaveLength(1);
  });

  // Its probe tests are its own: gone when it finishes, so none reaches the
  // chunk's commit; a folder of that name the project already had stays.
  it("deletes the probe folder it wrote in, and leaves one the project already had", async () => {
    const project = mkdtempSync(join(tmpdir(), "lax-skeptic-probes-"));
    try {
      agent.result = { stdout: "VERDICT: HOLDS\nFINDING: ran 3 probes.", exitCode: 0, durationMs: 1 };
      agent.during = (dir) => { mkdirSync(join(dir, ".skeptic"), { recursive: true }); writeFileSync(join(dir, ".skeptic", "probe.test.ts"), "it('x', () => {});"); };
      await runChunkSkeptic({ chunk, rawReport: "", preSha: "abc", projectDir: project });
      expect(existsSync(join(project, ".skeptic"))).toBe(false);

      mkdirSync(join(project, ".skeptic"));
      writeFileSync(join(project, ".skeptic", "theirs.txt"), "the project's own");
      await runChunkSkeptic({ chunk, rawReport: "", preSha: "abc", projectDir: project });
      expect(existsSync(join(project, ".skeptic", "theirs.txt"))).toBe(true);
    } finally {
      agent.during = undefined;
      rmSync(project, { recursive: true, force: true });
    }
  });
});
