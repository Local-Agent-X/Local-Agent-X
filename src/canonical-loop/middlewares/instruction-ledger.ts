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
 */
import { setOpLedger } from "../instruction-ledger/index.js";
import type { InstructionLedger } from "../instruction-ledger/index.js";
// extractConstraints lives in extract.ts (index.ts re-exports only the ledger
// accessors) — same canonical module, imported at its defining file.
import { extractConstraints } from "../instruction-ledger/extract.js";
import { getMiddlewareState } from "./state.js";
import type { CanonicalMiddleware } from "./types.js";

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
        ledger = await extract(ctx.userMessage);
      } catch {
        ledger = emptyLedger(); // fail open — an extractor fault constrains nothing
      }
      setOpLedger(ctx.op.id, ledger);
      return { kind: "continue" };
    },
  };
}

export const instructionLedgerMiddleware = createInstructionLedgerMiddleware();
