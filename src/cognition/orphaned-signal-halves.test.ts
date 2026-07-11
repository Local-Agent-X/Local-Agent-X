import { describe, it, expect } from "vitest";
import { SIGNALS } from "../orchestrator/registry.js";

// AM-6: several cognitive subsystems were orphaned halves — their write/create
// side had zero callers, so the store stayed permanently empty, yet the read
// side still ran every scheduled turn.
//
// Resolution (this campaign): the two flagged modules were deleted outright,
// with runtime evidence that their read sides could never emit:
//
//   - growth-tracker: recordSkillObservation()/detectMilestone() were never
//     called from anywhere (born caller-less), ~/.lax/growth-tracker.json was
//     never created, and signalsFor() returned [] over the empty store while
//     still being scheduled every 20th message.
//   - associative-recall: buildAssociations() — the only node writer — was
//     never called; recall() scores exclusively over store.nodes, so with a
//     permanently empty node set signalsFor() could never emit. Meanwhile the
//     wired record facet wrote junk word-pair edges to
//     ~/.lax/associative-memory.json every turn (202 edges, 0 nodes observed
//     in production) that nothing could ever recall.
//
// This test guards against half-reintroducing either module: if the feature
// comes back, it must come back with a real write path, not just a reader in
// the registry.

const ORPHANED_IDS = ["growth-tracker", "associative-recall"];

describe("AM-6 orphaned signal halves stay resolved", () => {
  it("deleted half-dead modules are not re-registered in the signal registry", () => {
    const ids = SIGNALS.map(s => s.id);
    for (const orphan of ORPHANED_IDS) {
      expect(ids).not.toContain(orphan);
    }
  });
});
