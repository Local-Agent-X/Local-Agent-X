// Kernel action derivation — the (tool → AriKernel action) the policy phase
// feeds into ariEvaluate. Each tool's action is its policy row's `ariAction`
// (tool-policies.types.ts AriActionSpec), and the row type requires one on
// every kernel-gated tool: a gated tool that fell through to "exec" was
// rejected by the kernel schema (exec is valid only for shell), and ariRequired
// turned every call into a block — image_search shipped exactly that way
// (2026-06-10), as "ARI error (ariRequired mode)".
//
// An action read off the call's args (http_request's method, browser's action)
// is what lets a preset that denies tainted http WRITES see them at all: the
// arikernel workspace-assistant preset allows a clean post/put/patch/delete
// (allow-http-write-clean, prio 100) and denies the same verbs under
// web/rag/email taint (deny-tainted-http-write, prio 40, wins).
import { TOOL_POLICIES } from "../tool-policy/tool-policies.js";
import type { AriActionSpec } from "../tool-policy/tool-policies.types.js";

function resolveSpec(spec: AriActionSpec, args: Record<string, unknown>): string {
  if (typeof spec === "string") return spec;
  const value = String(args?.[spec.arg] ?? "").toLowerCase();
  const write = spec.writes.find((w) => w.toLowerCase() === value);
  return write ? (spec.as ?? write.toLowerCase()) : "get";
}

/** The action the kernel judges this call as; "exec" for a tool with no row
 *  (the kernel never sees an internal tool). */
export function deriveAriAction(toolName: string, args: Record<string, unknown>): string {
  const spec = TOOL_POLICIES[toolName]?.ariAction;
  return spec === undefined ? "exec" : resolveSpec(spec, args);
}

/** Each kernel-gated tool's action when its args say nothing more: a fixed
 *  verb, or "get" for one read off the args. */
export const ARI_ACTION_MAP: Readonly<Record<string, string>> = Object.fromEntries(
  Object.entries(TOOL_POLICIES).flatMap(([name, row]) => (row.ariAction === undefined ? [] : [[name, resolveSpec(row.ariAction, {})]])),
);
