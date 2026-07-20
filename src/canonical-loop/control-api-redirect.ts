import { randomUUID } from "node:crypto";
import { readOp } from "../ops/op-store.js";
import { emit } from "./event-emitter.js";
import { publishSignal } from "./signals.js";
import { isTerminalState } from "./terminal-states.js";
import type { RedirectInstruction } from "./types.js";
import { writeSignalColumn, type ControlOk } from "./control-api.js";

export interface RedirectControlErr {
  ok: false;
  code: "unknown_op" | "invalid_op_id" | "invalid_instruction" | "terminal";
  message: string;
}
export type RedirectControlResult = ControlOk | RedirectControlErr;

export function opRedirect(opId: string, instruction: string, actor: string): RedirectControlResult {
  return applyRedirect(opId, instruction, actor);
}

export function opRedirectOnce(
  opId: string,
  instruction: string,
  actor: string,
  ingressKey: string,
): RedirectControlResult {
  return applyRedirect(opId, instruction, actor, ingressKey);
}

function applyRedirect(
  opId: string,
  instruction: string,
  actor: string,
  ingressKey?: string,
): RedirectControlResult {
  if (!opId) return { ok: false, code: "invalid_op_id", message: "opId must be a non-empty string" };
  if (!instruction) return { ok: false, code: "invalid_instruction", message: "instruction must be a non-empty string" };
  const op = readOp(opId);
  if (!op) return { ok: false, code: "unknown_op", message: `no op with id ${opId}` };
  if (isTerminalState(op.canonical?.state)) {
    return { ok: false, code: "terminal", message: `op ${opId} is already ${op.canonical?.state}` };
  }
  const now = new Date().toISOString();
  const instructionId = `ri-${randomUUID()}`;
  const next: RedirectInstruction = { instructionId, text: instruction, receivedAt: now };
  let duplicate = false;
  writeSignalColumn(opId, op, canonical => {
    if (ingressKey && canonical.redirectIngressKeys?.includes(ingressKey)) {
      duplicate = true;
      return;
    }
    canonical.redirectInstruction = next;
    canonical.redirectReceivedAt = now;
    if (ingressKey) canonical.redirectIngressKeys = [...(canonical.redirectIngressKeys ?? []).slice(-255), ingressKey];
  });
  if (duplicate) return { ok: true };
  emit(opId, "redirect_received", { actor, instructionId });
  publishSignal({ kind: "redirect", opId, actor, ts: now, instructionId });
  return { ok: true };
}
