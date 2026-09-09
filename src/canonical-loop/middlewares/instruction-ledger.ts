/**
 * Instruction-ledger population — parses the op's kickoff user message for
 * explicit run constraints ("don't edit any code", "commit when done") and
 * records them in the per-op instruction ledger. Runs in beforeTurn of turn 0
 * ONLY, i.e. before the model's first tool call, so pre-dispatch capability
 * gating can read the ledger from the very first dispatch.
 *
 * FAIL-OPEN: if extraction throws, the EMPTY ledger is recorded — an
 * unconstrained op must never be blocked or nudged by this path (and the
 * ledger accessors themselves default permissive when no entry exists).
 *
 * NOT for synthetic op contexts: an app_build op's turn-0 message is the
 * harness-authored per-build context (env rules, "you must NOT edit core LAX",
 * "leave the locked baseline alone", "do NOT recreate the skeleton") — NOT a
 * user instruction. Running the constraint extractor on it made the LLM confirm
 * a phantom `workspace-write` ban that blocked the build sub-agent from writing
 * a single line of app code. The user's REAL constraints live on the parent
 * chat op (a different op), which is unaffected — so app_build ops skip
 * extraction entirely and stay unconstrained.
 */
import { setOpLedger } from "../instruction-ledger/index.js";
import type { InstructionLedger } from "../instruction-ledger/index.js";
// extractConstraints lives in extract.ts (index.ts re-exports only the ledger
// accessors) — same canonical module, imported at its defining file.
import { extractConstraints } from "../instruction-ledger/extract.js";
import { getMiddlewareState } from "./state.js";
import { isHarnessAuthoredTask, type CanonicalMiddleware } from "./types.js";

interface FiredFlag { fired: boolean }

type ExtractFn = (userMessage: string) => Promise<InstructionLedger>;

function emptyLedger(): InstructionLedger {
  return { prohibitions: [], obligations: [], phrases: [] };
}

/** Factory — the extractor is injectable so tests run without a live LLM
 *  (mirrors the injectable `confirm` default param inside extract.ts). */
export function createInstructionLedgerMiddleware(
  extract: ExtractFn = extractConstraints,
): CanonicalMiddleware {
  return {
    name: "instruction-ledger",

    async beforeTurn(ctx) {
      if (ctx.turnIdx !== 0) return { kind: "continue" };

      // Synthetic-context ops carry harness directives, not user constraints —
      // record an empty ledger and never run the extractor. The two signals
      // that decide this (the synthetic op-type set and the per-op provenance
      // stamp) live in types.js next to isWorkerOp; see isHarnessAuthoredTask
      // for why both are needed and why it is NOT the worker-lane predicate.
      if (isHarnessAuthoredTask(ctx)) {
        setOpLedger(ctx.op.id, emptyLedger());
        return { kind: "continue" };
      }

      const flag = getMiddlewareState<FiredFlag>(
        ctx.op.id,
        "instruction-ledger",
        () => ({ fired: false }),
      );
      if (flag.fired) return { kind: "continue" };
      // Set BEFORE the await — a re-driven turn 0 (retry-iteration) must not
      // race a second extraction while the first is still in flight.
      flag.fired = true;

      let ledger: InstructionLedger;
      try {
        ledger = await extract(ctx.currentUserMessage);
      } catch {
        ledger = emptyLedger(); // fail open — an extractor fault constrains nothing
      }
      setOpLedger(ctx.op.id, ledger);
      return { kind: "continue" };
    },
  };
}

export const instructionLedgerMiddleware = createInstructionLedgerMiddleware();
