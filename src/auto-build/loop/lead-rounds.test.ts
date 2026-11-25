// A fix round decided by the build's lead, with the engine's guards on it.
// label-check-sol's chunk 1 closed every finding it was given and was set
// aside after three rounds anyway, ending the build (2026-11-24): a lead can
// keep such a chunk going, accept it with follow-ups, or narrow its contract.
import { describe, it, expect, vi } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ChunkReviewOutcome } from "../chunk-review/index.js";
import type { ParsedChunk, ParsedPlan } from "../plan-parser.js";
import type { LeadDecision } from "../advisor/lead-decisions.js";
import { planLeadRound } from "./lead-rounds.js";

const chunk = { number: 1, title: "Android foundation", slice: "s", doneWhen: "fixtures prove every gate", scenarios: "—", dependsOn: [] } as unknown as ParsedChunk;
const plan = { chunks: [chunk] } as unknown as ParsedPlan;
const report = { status: "done", doneWhen: "met", note: "", specGaps: "" } as unknown as ChunkReviewOutcome["report"];
const sentBack = (gate: string, reasoning = "the size gate skips root build/") =>
  ({ action: "push_back", reasoning, findings: [{ gate, action: "push_back", reasoning }], report }) as unknown as ChunkReviewOutcome;

function round(decision: LeadDecision | null, outcome = sentBack("skeptic"), final = false) {
  const projectDir = mkdtempSync(join(tmpdir(), "lax-lead-round-"));
  mkdirSync(join(projectDir, "spec"));
  const said: string[] = [];
  const ask = vi.fn(async () => decision);
  const run = planLeadRound({
    lead: { projectDir, originSessionId: "chat-x" }, chunk, plan, outcome, totalChunks: 5, round: 3, earlier: [], repeated: false,
    projectDir, emit: (e) => { said.push(e.message); }, ask, ...(final ? { final } : {}),
  });
  return { run, said, projectDir, ask };
}
const buildState = (dir: string) => readFileSync(join(dir, "spec", "build-state.md"), "utf-8");

describe("planLeadRound", () => {
  it("accept lands the chunk and puts what is left on record", async () => {
    const { run, said, projectDir } = round({ action: "accept", reasoning: "the gates hold for every real layout", followUps: ["root build/ is skipped"] });
    const plan1 = await run;
    expect(plan1).toMatchObject({ kind: "land", outcome: { action: "proceed", reasoning: "Accepted by the build lead: the gates hold for every real layout" } });
    expect(buildState(projectDir)).toContain("- root build/ is skipped");
    expect(said[0]).toBe("build lead: accept — the gates hold for every real layout");
  });

  it("never accepts a chunk whose build, tests or held-out scenarios fail", async () => {
    for (const gate of ["build-exec", "chunk-scenarios"]) {
      const { run, said } = round({ action: "accept", reasoning: "good enough" }, sentBack(gate, "npm test exited 1"));
      expect(await run).toMatchObject({ kind: "rebuild", retryReason: expect.stringContaining("npm test exited 1") });
      expect(said[1]).toContain(`accept refused: the ${gate} check failed`);
    }
  });

  it("narrow rebuilds against the lead's done-when, on record", async () => {
    const { run, projectDir } = round({ action: "narrow", reasoning: "no edge to it", doneWhen: "fixtures prove the size gate for src/" });
    const next = await run;
    expect(next).toMatchObject({ kind: "rebuild", chunk: { doneWhen: "fixtures prove the size gate for src/" } });
    expect(buildState(projectDir)).toContain("narrowed this chunk's done-when to: fixtures prove the size gate for src/");
  });

  it("continue sends the worker the lead's instruction with the finding; park stops on the owner's question", async () => {
    expect(await round({ action: "continue", reasoning: "real", instruction: "check root build/ too" }).run)
      .toMatchObject({ kind: "rebuild", retryReason: expect.stringMatching(/^check root build\/ too[\s\S]*size gate skips root build/) });
    expect(await round({ action: "park", reasoning: "taste", question: "Ship without the Android check?" }).run)
      .toEqual({ kind: "halt", reasoning: "The build lead needs the owner to decide: Ship without the Android check?" });
  });

  // The last word on a chunk whose rounds are spent (label-check-sol chunk 3,
  // 2026-11-25: the engine set it aside at the ceiling without asking).
  describe("once the rounds are spent", () => {
    it("the lead is told so, and its accept lands the chunk", async () => {
      const { run, ask } = round({ action: "accept", reasoning: "the manual flow works; the rest are new kinds of input" }, sentBack("skeptic"), true);
      expect(await run).toMatchObject({ kind: "land", outcome: { action: "proceed" } });
      expect(ask.mock.calls[0]).toEqual([expect.anything(), expect.objectContaining({ final: true, maxRounds: 8 }), expect.anything()]);
    });

    it("an answer that would build again sets the chunk aside, and a narrowing is not recorded", async () => {
      for (const decision of [
        { action: "continue", reasoning: "one more edge", instruction: "fix it" },
        { action: "fresh", reasoning: "start over", instruction: "fix it" },
        { action: "narrow", reasoning: "smaller", doneWhen: "the manual flow" },
      ] as LeadDecision[]) {
        const { run, projectDir } = round(decision, sentBack("skeptic", "U+2028 splits an entry"), true);
        const next = await run;
        expect(next).toMatchObject({ kind: "halt", reasoning: expect.stringContaining("spent its 8 fix rounds") });
        expect((next as { reasoning: string }).reasoning).toContain("U+2028 splits an entry");
        expect(() => buildState(projectDir)).toThrow();
      }
    });

    it("an accept the engine refuses sets it aside too", async () => {
      const { run } = round({ action: "accept", reasoning: "good enough" }, sentBack("build-exec", "npm test exited 1"), true);
      expect(await run).toMatchObject({ kind: "halt" });
    });
  });

  it("no answer is no plan: the engine's rules decide", async () => {
    const { run, said } = round(null);
    expect(await run).toBeNull();
    expect(said[0]).toContain("no answer in time");
  });
});
