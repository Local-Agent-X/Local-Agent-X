/**
 * The three finishing checks of a coding turn — spec-probe, spec-audit,
 * regression-audit (decide-outcome-verify-gates.ts) — run together, and not at
 * all when a frontier model has already proven its work.
 *
 * Measured 2026-11-13 (13 coding tasks, Opus 5.5, LAX code mode): run one after
 * another they added about 13 s after the model's final answer on every task,
 * and changed no outcome (audit MET 13/13, regression clean 13/13, probe found
 * nothing; 5 probes could not even run). Claude Code on the same tasks has no
 * such step.
 *
 * TOGETHER: the gates keep their order (COMPLETION_GATES) and their meaning.
 * The first to run starts all three; each gate then awaits its own result.
 * The audits mark their once-per-op chance spent only when their gate uses the
 * result (deferMark), so when an earlier check sends the work back, the early
 * results are dropped and the audits run fresh on the next "done", exactly as
 * they did one after another.
 *
 * NOT AT ALL: when the model is a vendor's full-size hosted model
 * (isFrontierModel) and a check of its own (type-check, build, tests) passed
 * after its last edit (verify-gate's ledger). A local model, a vendor's small
 * tier (Haiku, mini, nano, Flash, fast), or one that finished without that
 * proof gets the checks as before: that is where they earn their place.
 */
import type { Op } from "../../ops/types.js";
import { resolveOpModel } from "../op-model.js";
import { isFrontierModel } from "../../model-tiers.js";
import { opSourceCheckedSinceLastEdit } from "../middlewares/verify-gate.js";
import { runSpecProbeGate, type SpecProbeGateResult } from "./spec-probes.js";
import { runSpecAuditGate, type SpecAuditGateResult } from "./spec-audit.js";
import { runRegressionAuditGate, type RegressionAuditGateResult } from "./regression-audit.js";

export interface FinishingChecks {
  probe: Promise<SpecProbeGateResult>;
  spec: Promise<SpecAuditGateResult>;
  regression: Promise<RegressionAuditGateResult>;
}

const started = new Map<string, FinishingChecks>();
const key = (opId: string, turnIdx: number): string => `${opId}#${turnIdx}`;

/** A frontier model whose own check passed after its last edit. */
export function provenByFrontierModel(op: Op): boolean {
  if (!opSourceCheckedSinceLastEdit(op.id)) return false;
  const model = resolveOpModel(op);
  return !!model && isFrontierModel(model);
}

/** The turn's three checks, started together on first ask. */
export function finishingChecks(op: Op, turnIdx: number, signal?: AbortSignal): FinishingChecks {
  const k = key(op.id, turnIdx);
  let checks = started.get(k);
  if (!checks) {
    checks = {
      probe: runSpecProbeGate(op),
      spec: runSpecAuditGate(op, { signal, deferMark: true }),
      regression: runRegressionAuditGate(op, { signal, deferMark: true }),
    };
    // A check that throws reads as "no finding", as an awaited one did.
    for (const p of Object.values(checks)) (p as Promise<unknown>).catch(() => undefined);
    started.set(k, checks);
  }
  return checks;
}

/** Forget the turn's checks: the turn re-opened, or the last one was used. */
export function dropFinishingChecks(opId: string, turnIdx: number): void {
  started.delete(key(opId, turnIdx));
}
