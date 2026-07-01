// Pure decision helpers for shell-class tool blocks — split out of enforce-policy
// to keep it under the source-hygiene LOC ceiling. Both functions take a tool name
// + taint/args and return a message or null; no side effects, no enforce-policy
// internals (only hasCapability). Pinned by ari-taint-shell-contract.test.ts (the
// tainted-shell pre-gate against the live kernel) and blocked-self-verify.test.ts.

import { hasCapability } from "../tool-registry.js";

// Kernel taint sources that @arikernel/core's deny-tainted-shell rule treats as
// untrusted content (its `match.taintSources`). Mirrored here so LAX can PRE-EMPT
// the shell denial before the kernel observes the taint+shell event — see
// taintedShellBlockReason. Kept in lockstep with the real rule by
// ari-taint-shell-contract.test.ts (drives the live kernel against this helper).
const SHELL_TAINT_DENY_SOURCES: ReadonlySet<string> = new Set(["web", "rag", "email"]);

/**
 * If `toolName` is a shell-class tool AND the session carries untrusted
 * (web/rag/email) taint, return a clear denial message; otherwise null.
 *
 * WHY pre-empt the kernel: the kernel's deny-tainted-shell would also deny, but
 * its `web_taint_sensitive_probe` behavioral rule QUARANTINES the whole run on a
 * taint+shell attempt — and a quarantined run also blocks file WRITES. That
 * bricks legit editing for the rest of the op after the agent merely read a
 * credential/.env file. Denying HERE keeps shell blocked (the real exfil wall —
 * `bash` is NOT egress-gated, so deny-tainted-shell is its only backstop) WITHOUT
 * the write-blocking quarantine. Egress keeps its own independent guards; this
 * changes nothing there. Pure + exported for the contract test.
 */
export function taintedShellBlockReason(toolName: string, taintSources: readonly string[]): string | null {
  if (!hasCapability(toolName, "shell")) return null;
  const hit = taintSources.filter((s) => SHELL_TAINT_DENY_SOURCES.has(s));
  if (hit.length === 0) return null;
  return `Shell is blocked for this task: this session read sensitive/credential content (taint: ${hit.join(", ")}), and running a shell command after reading secrets is an exfiltration risk, so shell stays denied while the session is tainted. This does NOT block your file edits (read/write/edit) or the build/verify typecheck — keep using those to make progress. If that read was intended and safe, ask the user to clear it in Settings (declassify). The lock resets on your next turn.`;
}

// A verify-shaped shell command = a delegated agent running the project's own
// build/type-check/lint/test. When the security layer blocks one (worktree
// isolation / shell policy on source paths), the raw block carries a GENERIC
// recovery + the commandShell hint ("find a safer way, often a dedicated tool
// exists") — which sends the model hunting an alternative executor that does not
// exist, burning turns and wrapping up "I couldn't verify". There is no in-policy
// way to run these on source, and none is needed: the orchestrator build-verify
// gate (build-verify.ts) runs the project's build at turn end and hands real
// errors back. Detecting this exact case lets the block carry accurate, actionable
// guidance the model actually reads (metadata.recovery/userHint render into the
// tool result — result-helpers.ts).
const SELF_VERIFY_CMD =
  /\b(tsc|tsgo|vitest|jest|eslint|typecheck|type-check)\b|\b(npm|npx|pnpm|yarn|bun|deno)\s+(run\s+)?(build|check|typecheck|type-check|lint|test)\b/i;

/** When a shell-class tool is blocked running the project's build/type-check,
 *  return guidance aligned with the harness's auto-verify (so the model stops
 *  retrying the blocked command); otherwise null. Pure + exported for its test. */
export function blockedSelfVerifyGuidance(
  toolName: string,
  args: unknown,
): { recovery: string; userHint: string } | null {
  if (!hasCapability(toolName, "shell")) return null;
  const cmd = args && typeof args === "object" ? (args as { command?: unknown }).command : undefined;
  if (typeof cmd !== "string" || !SELF_VERIFY_CMD.test(cmd)) return null;
  return {
    recovery:
      "You don't need to run the project's build or type-check yourself — a delegated agent can't run shell commands on source paths, and it doesn't have to. The harness runs the project's build automatically when your turn ends and hands back any real errors. Stop retrying this command: make your edits with the file tools and finish the turn. Verification is handled.",
    userHint:
      "I can't run the type-check directly here, but the harness verifies the project's build automatically when the turn ends — I'll finish the edits and let it check.",
  };
}
