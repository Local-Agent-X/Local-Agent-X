// Pure decision helpers for shell-class tool blocks — split out of enforce-policy
// to keep it under the source-hygiene LOC ceiling. Both functions take a tool name
// + taint/args and return a message or null; no side effects, no enforce-policy
// internals (only hasCapability). Pinned by ari-taint-shell-contract.test.ts (the
// tainted-shell pre-gate against the live kernel) and blocked-self-verify.test.ts.

import { hasCapability } from "../tool-registry.js";
import { findTaintInPayload, detectSecretsInOutput } from "../data-lineage/index.js";

// Kernel taint sources that @arikernel/core's deny-tainted-shell rule treats as
// untrusted content (its `match.taintSources`). Mirrored here so LAX can PRE-EMPT
// the shell denial before the kernel observes the taint+shell event — see
// taintedShellBlockReason. Kept in lockstep with the real rule by
// ari-taint-shell-contract.test.ts (drives the live kernel against this helper).
// Exported so the enforce-policy call site can strip these sources from the labels
// it hands the kernel for a shell call the payload-evidence gate has CLEARED (so
// the kernel's temporal deny-tainted-shell can't re-deny the benign command).
export const SHELL_TAINT_DENY_SOURCES: ReadonlySet<string> = new Set(["web", "rag", "email"]);

/** Collect the shell command TEXT from a tool call's args, for payload-evidence
 *  scanning. Joins the primary `command` with any other string arg values (a
 *  shell-class tool may carry its payload in `command`, an `args`/`argv` array, a
 *  `script`, etc.) so the taint-overlap / secret-shape check sees everything that
 *  will actually run — not just one well-known field. */
function shellCommandPayload(args: unknown): string {
  if (!args || typeof args !== "object") return "";
  const parts: string[] = [];
  for (const v of Object.values(args as Record<string, unknown>)) {
    if (typeof v === "string") parts.push(v);
    else if (Array.isArray(v)) for (const x of v) if (typeof x === "string") parts.push(x);
  }
  return parts.join(" ");
}

/**
 * If `toolName` is a shell-class tool AND the session carries untrusted
 * (web/rag/email) taint AND the command itself carries PAYLOAD EVIDENCE of
 * exfiltration, return a denial message; otherwise null (allow).
 *
 * PAYLOAD-EVIDENCE GATE (chunk L — fixes the audit's worst false-positive class).
 * The old rule denied ANY shell command once the session had read web/rag/email
 * content — purely temporal. A benign `npm test` / `python3 -m pytest` after
 * reading docs was denied, and (once the kernel saw it) quarantined the whole run
 * into restricted mode, cascading denials onto every later write/shell. That
 * bricked benchmark runs (Jun 29: 12 consecutive denials; Jul 1: 25). This is the
 * same FP class the campaign already fixed for the threat engine (chunks A/B):
 * restriction requires DETERMINISTIC PAYLOAD EVIDENCE, not a sequence.
 *
 * A tainted-session shell is now denied ONLY when the command text proves it
 * carries the sensitive data outward:
 *   (1) it OVERLAPS the session's tainted bytes — findTaintInPayload, matching the
 *       raw text or any decoded/normalized evasion view (base64/hex/percent/
 *       homoglyph) against the recorded content fingerprints; or
 *   (2) it carries SECRET-SHAPED content — detectSecretsInOutput, keyed on
 *       `structured` only (a real API-key/PEM/JWT/known-credential shape), NOT the
 *       loose high-entropy catch-all, so a long build hash or git SHA in an
 *       argument can't brick a benign command.
 * No evidence → ALLOW. The mere sequence "web read → shell" is not exfil.
 *
 * WHY this is still safe: the LAX layer OWNS the tainted-shell decision (it
 * front-runs the kernel's coarse deny-tainted-shell). Real runtime-composed exfil
 * that never puts the tainted bytes in the command TEXT (e.g. `cat secret | curl`)
 * is caught downstream by the payload-based egress / data-lineage / canary gates,
 * which scan the actual outbound bytes — not by temporal correlation here. Pure +
 * exported for the contract test.
 */
export function taintedShellBlockReason(
  toolName: string,
  taintSources: readonly string[],
  sessionId: string,
  args: unknown,
): string | null {
  if (!hasCapability(toolName, "shell")) return null;
  const hit = taintSources.filter((s) => SHELL_TAINT_DENY_SOURCES.has(s));
  if (hit.length === 0) return null;

  const payload = shellCommandPayload(args);
  const overlap = findTaintInPayload(sessionId, payload); // tainted bytes in the command
  const secret = detectSecretsInOutput(payload); // secret-shaped content in the command
  // No deterministic evidence the command carries the tainted/secret data → ALLOW.
  if (overlap.length === 0 && !secret.structured) return null;

  const evidence =
    overlap.length > 0
      ? `the command text carries bytes from a tainted source (${[...new Set(overlap.map((o) => o.source))].join(", ")})`
      : `the command carries secret-shaped content (${secret.kinds.join(", ")})`;
  return `Shell is blocked for this command: ${evidence}, and running it while the session is tainted (${hit.join(", ")}) is an exfiltration risk, so THIS command stays denied. This does NOT block your file edits (read/write/edit), the build/verify typecheck, or benign shell commands that don't carry the tainted/secret data — keep using those to make progress. If this was intended and safe, ask the user to clear it in Settings (declassify). The lock resets on your next turn.`;
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
 *  retrying the blocked command); otherwise null. Pure + exported for its test.
 *
 *  `shellAvailable` — pass true when shell IS available to this delegated agent
 *  (worktree isolation + effective OS containment; see
 *  SecurityLayer.delegatedShellContained). A contained delegated agent CAN run
 *  its verify, so a block it hit was NOT "delegated agents can't run shell" — the
 *  redirect would misinform. Suppress it (return null) and let the caller's real
 *  block reason stand. When shell is genuinely unavailable (no worktree /
 *  unconfined-unacknowledged / cron / non-delegated), the redirect fires. */
export function blockedSelfVerifyGuidance(
  toolName: string,
  args: unknown,
  shellAvailable = false,
): { recovery: string; userHint: string } | null {
  if (!hasCapability(toolName, "shell")) return null;
  if (shellAvailable) return null;
  const cmd = args && typeof args === "object" ? (args as { command?: unknown }).command : undefined;
  if (typeof cmd !== "string" || !SELF_VERIFY_CMD.test(cmd)) return null;
  return {
    recovery:
      "You don't need to run the project's build or type-check yourself — a delegated agent can't run shell commands on source paths, and it doesn't have to. The harness runs the project's build automatically when your turn ends and hands back any real errors. Stop retrying this command: make your edits with the file tools and finish the turn. Verification is handled.",
    userHint:
      "I can't run the type-check directly here, but the harness verifies the project's build automatically when the turn ends — I'll finish the edits and let it check.",
  };
}
