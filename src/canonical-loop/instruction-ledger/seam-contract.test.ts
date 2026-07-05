/**
 * CROSS-SEAM CONTRACT — one instruction-ledger write must reach BOTH sides of
 * the seam it exists to unify:
 *
 *   Consumer A — the pre-dispatch TOOL gate (src/tools/pre-dispatch.ts) keys its
 *     per-op hard-deny on opForbidsCapability(opId, cls) (pre-dispatch.ts ~L176).
 *   Consumer B — the loop's PERSISTENCE guards (the middlewares that stop an op
 *     from persisting as "done" prematurely) read the same record;
 *     premature-completion is the guard on the turn-loop's tool-less "done"
 *     path and must SUPPRESS its keep-working nudge when the user forbade
 *     workspace writes (a read-only op legitimately answers with only text).
 *
 * The two consumers live in different layers and import the ledger
 * independently. If either drifted off the shared record the regression would
 * be SILENT — a write allowed against a "read-only" instruction, or a nudge
 * fired at an op the user asked to leave untouched. Neither consumer's own
 * suite catches that: pre-dispatch.test.ts proves the tool gate end-to-end,
 * premature-completion.test.ts proves the guard in isolation, but nothing pins
 * them to ONE ledger write. This test is that pin.
 *
 * FAIL-OPEN is half the contract: an empty ledger (and an op with no ledger at
 * all) must leave BOTH consumers permissive.
 */
import { describe, it, expect, afterEach } from "vitest";
import { setOpLedger, opForbidsCapability } from "./index.js";
import { _resetOpLedgers } from "./ledger.js";
import { prematureCompletionMiddleware } from "../middlewares/premature-completion.js";
import type { CanonicalLoopContext } from "../middlewares/types.js";

// A worker-op turn that ends tool-lessly with a final-sounding summary and
// nothing committed — the exact shape premature-completion nudges, UNLESS the
// op forbids workspace writes. Mirrors premature-completion.test.ts's ctx.
function toollessDoneCtx(opId: string): CanonicalLoopContext {
  return {
    op: { id: opId, lane: "agent" },
    userMessage: "refactor the parser and save the result",
    assistantContent: "All done — here's a summary of what I'd change.",
    toolCalls: [],
    committingToolsThisOp: new Set<string>(),
  } as unknown as CanonicalLoopContext;
}

const runPersistenceGuard = (c: CanonicalLoopContext) =>
  prematureCompletionMiddleware.afterModelCall!(c);

afterEach(() => _resetOpLedgers());

describe("instruction-ledger cross-seam contract (pre-dispatch gate ↔ persistence guard)", () => {
  it("a workspace-write prohibition drives BOTH consumers from one ledger write", async () => {
    const opId = "op-seam-forbid";
    setOpLedger(opId, {
      prohibitions: ["workspace-write"],
      obligations: [],
      phrases: ["read-only, just tell me what's wrong"],
    });

    // Consumer A — the predicate the pre-dispatch gate hard-denies writes on.
    expect(opForbidsCapability(opId, "workspace-write")).toBe(true);

    // Consumer B — the persistence guard SUPPRESSES its keep-working nudge.
    expect((await runPersistenceGuard(toollessDoneCtx(opId))).kind).toBe("continue");
  });

  it("an empty ledger leaves BOTH consumers permissive (fail-open)", async () => {
    const opId = "op-seam-empty";
    setOpLedger(opId, { prohibitions: [], obligations: [], phrases: [] });

    // Consumer A — nothing forbidden.
    expect(opForbidsCapability(opId, "workspace-write")).toBe(false);

    // Consumer B — guard fires its normal keep-working nudge.
    expect((await runPersistenceGuard(toollessDoneCtx(opId))).kind).toBe("nudge");
  });

  it("an op with NO ledger at all is permissive on both sides (fail-open)", async () => {
    const opId = "op-seam-none";

    expect(opForbidsCapability(opId, "workspace-write")).toBe(false);
    expect((await runPersistenceGuard(toollessDoneCtx(opId))).kind).toBe("nudge");
  });

  it("a prohibition on an UNRELATED class doesn't suppress either consumer", async () => {
    const opId = "op-seam-egress-only";
    setOpLedger(opId, { prohibitions: ["egress"], obligations: [], phrases: ["stay offline"] });

    // Consumer A — the workspace-write predicate the write gate reads stays false.
    expect(opForbidsCapability(opId, "workspace-write")).toBe(false);

    // Consumer B — the workspace-write-guarded persistence nudge still fires.
    expect((await runPersistenceGuard(toollessDoneCtx(opId))).kind).toBe("nudge");
  });
});
