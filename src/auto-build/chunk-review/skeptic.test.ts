// The chunk skeptic: its verdict parse (default to broken), its process-failure
// direction (not-run, never broken), and what its brief hands it.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const agent = vi.hoisted(() => ({
  result: { stdout: "", exitCode: 0, durationMs: 1 } as { stdout: string; exitCode: number; durationMs: number; error?: string },
  calls: [] as Array<{ role: string; task: string; projectDir?: string }>,
  /** What the skeptic does in the project while it runs (writes a probe). */
  during: undefined as ((projectDir: string) => void) | undefined,
}));

vi.mock("../agents/chunk-runner.js", () => ({
  SKEPTIC_PROBE_DIR: ".skeptic",
  runChunkAgent: vi.fn(async (opts: { role: string; task: string; projectDir?: string }) => {
    agent.calls.push(opts);
    agent.during?.(opts.projectDir!);
    return agent.result;
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

  it("no verdict line is broken: the skill's default when unsure", () => {
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
    expect(task).toMatch(/Default to broken if unsure/);
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
