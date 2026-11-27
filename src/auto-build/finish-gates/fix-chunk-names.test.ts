// A finish fix's number (1011) is the engine's, for branches and records. The
// owner read it on the AGENTS panel, the skeptic's card and the build card's
// progress lines (2026-11-25, again 2026-11-26): what they read names a fix by
// its title.
import { describe, expect, it } from "vitest";
import { nameFinishFixes } from "./fix-chunk.js";

const fixes = [
  { number: 1011, title: "Finish fix 1: hostile findings" },
  { number: 1012, title: "Finish fix 1: unlucky findings" },
];

describe("nameFinishFixes", () => {
  it("puts each finish fix by its title, in every form the engine writes the number", () => {
    expect(nameFinishFixes("Chunk 1011 judged: scenarios not scored", fixes)).toBe("Finish fix 1: hostile findings judged: scenarios not scored");
    expect(nameFinishFixes("Starting chunk 1012/5 in worktree autobuild-c1012", fixes)).toBe("Starting Finish fix 1: unlucky findings in worktree autobuild-c1012");
    expect(nameFinishFixes("[2.0s] [chunk 1011/5] push-back: Chunk 1011: fix round 1 closed", fixes))
      .toBe("[2.0s] [Finish fix 1: hostile findings] push-back: Finish fix 1: hostile findings: fix round 1 closed");
    expect(nameFinishFixes("the skeptic broke chunk 1011's guard", fixes)).toBe("the skeptic broke Finish fix 1: hostile findings's guard");
  });

  it("names a fix once where its title already follows the number", () => {
    expect(nameFinishFixes('Decision bd-1: chunk 1011/5, "Finish fix 1: hostile findings", after round 1', fixes))
      .toBe("Decision bd-1: Finish fix 1: hostile findings, after round 1");
  });

  it("leaves a plan's chunks, a fix not given, and numbers inside other words alone", () => {
    expect(nameFinishFixes("Chunk 7 landed; chunk 1013 waits; took 1011ms; chunk 10110", fixes)).toBe("Chunk 7 landed; chunk 1013 waits; took 1011ms; chunk 10110");
  });
});
