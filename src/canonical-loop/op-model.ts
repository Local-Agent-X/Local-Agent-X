// Single source for "what model is this op running on", resolved in order of
// authority:
//   1. op.model explicitly set on the op (worker contexts, etc.)
//   2. op.canonical.model from the resolved request
//   3. the user's configured model in ~/.lax/settings.json (the model the chat
//      is actually running — just looked up from a different place when it
//      didn't propagate onto the op)
//
// host.ts treats undefined as a real upstream plumbing bug and throws; best-
// effort callers (history compaction) treat undefined as "skip, don't guess".

import type { Op } from "../ops/types.js";
import { getSetting } from "../settings.js";

export function resolveOpModel(op: Op): string | undefined {
  const onOp = (op as { model?: string }).model
    ?? (op as { canonical?: { model?: string } }).canonical?.model;
  if (onOp) return onOp;
  const saved = getSetting<string>("model");
  return typeof saved === "string" && saved.length > 0 ? saved : undefined;
}
