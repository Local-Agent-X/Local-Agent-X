// Harness-initiated shell commands: the orchestrator running the project's
// own build between turns (build-verify) or executing a spec probe
// (spec-probes). The MODEL did not call these, so the model-facing gates —
// policy rules, approval cards, RBAC, the threat engine — don't apply: an
// approval card for a build the harness decided to run would be asking the
// user to approve the harness's own check. Two gates still do, and this seam
// exists so they can't be skipped by calling bashTool.execute directly:
//
//   - the shell kill switch: a user who turned shell access off in Settings
//     → Security gets no shell from the harness either;
//   - the audit trail: every command that runs on the user's machine leaves a
//     hash-chained record, harness or not.
//
// The cage is bashTool's own and applies regardless.
import { bashTool } from "../tools/shell-tool.js";
import { statusOf } from "../tools/result-helpers.js";
import { getSetting } from "../settings.js";
import { getSharedAuditTrail } from "../threat/audit-trail.js";
import { getLaxDir } from "../lax-data-dir.js";
import { killSwitchBlock } from "./kill-switch-gates.js";

export interface HarnessCommand {
  command: string;
  cwd: string;
  timeoutMs: number;
  signal?: AbortSignal;
  /** Who is running this and why — lands in the audit record. */
  purpose: "build-verify" | "spec-probe";
  /** The op the check belongs to, for the audit record. */
  opId: string;
}

export interface HarnessCommandResult {
  /** Clean exit. Anything else — error, timeout, blocked — is false. */
  ok: boolean;
  /** The tool-result status ("ok", "error", "timeout", …); "blocked" when the kill switch refused. */
  status: string;
  output: string;
}

export async function executeHarnessCommand(req: HarnessCommand): Promise<HarnessCommandResult> {
  const audit = getSharedAuditTrail(getLaxDir());
  const block = killSwitchBlock("bash", { enableShell: getSetting<boolean>("enableShell") });
  if (block) {
    audit.record({
      sessionId: req.opId,
      event: "harness_exec",
      toolName: "bash",
      decision: "block",
      reason: `${req.purpose}: ${block.reason}`,
      controlsApplied: ["HarnessExec", "KillSwitch"],
    });
    return { ok: false, status: "blocked", output: block.reason };
  }
  audit.record({
    sessionId: req.opId,
    event: "harness_exec",
    toolName: "bash",
    decision: "allow",
    reason: `${req.purpose}: ${req.command}`,
    controlsApplied: ["HarnessExec", "KillSwitch"],
  });
  const r = await bashTool.execute({ command: req.command, _cwd: req.cwd, _signal: req.signal, timeout: req.timeoutMs });
  const status = statusOf(r);
  return { ok: status === "ok", status, output: r.content ?? "" };
}
