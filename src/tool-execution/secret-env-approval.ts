/**
 * Handing a vault secret to a shell command (bash `secret_env`) is the
 * profile's `secrets` risk class: Safe refuses, Normal and Power ask once per
 * program and secret ("always allow" covers exactly that pair, see
 * computeArgsFingerprint's `use_secret`), Autonomous runs it. Peter,
 * 2026-09-26: "A is the right pick for power users … c behavior when users
 * have settings set to autonomous."
 *
 * The card exists because a secret inside a shell reaches any program the
 * command runs, and nothing checks where that program sends it — a model
 * steered by a web page could leak a token it never saw. The value itself
 * never reaches the model either way (tools/shell-secret-env.ts).
 */
import { USER_HINTS, type ToolResult } from "../types.js";
import { decisionDenies, decisionRequiresPrompt, getApprovalManager, getRiskDecision, type ApprovalDenyReason } from "../approval-manager.js";
import { secretEnvOf, secretEnvProgram } from "../tools/shell-secret-env.js";
import type { ToolCallContext } from "./context.js";

export const SECRET_USE_TOOL = "use_secret";

export type SecretEnvGate =
  | { kind: "continue" }
  | { kind: "blocked"; result: ToolResult }
  | { kind: "denied"; reason: ApprovalDenyReason | undefined };

export async function secretEnvGate(ctx: ToolCallContext): Promise<SecretEnvGate> {
  if (ctx.tc.name !== "bash") return { kind: "continue" };
  let secretEnv;
  try { secretEnv = secretEnvOf(ctx.args); } catch { return { kind: "continue" }; /* the tool reports the malformed arg */ }
  if (!secretEnv) return { kind: "continue" };

  const rule = getRiskDecision("secrets", ctx.sessionId);
  const names = [...new Set(Object.values(secretEnv))].sort();
  const blockedResult = (content: string): SecretEnvGate => ({
    kind: "blocked",
    result: { content, isError: true, status: "blocked", metadata: { layer: "approval", userHint: USER_HINTS.policy } },
  });
  if (decisionDenies(rule)) {
    return blockedResult(`BLOCKED by profile: this profile does not let a vault secret (${names.join(", ")}) be handed to a command. Use http_request with {{SECRET_NAME}} in a header, or ask the user to run the command.`);
  }
  if (!decisionRequiresPrompt(rule)) return { kind: "continue" };
  if (ctx.callContext !== "local" || !ctx.onEvent) {
    return blockedResult(`BLOCKED: handing ${names.join(", ")} to a command needs the user's yes under this profile, and no one can be asked on this run.`);
  }

  const command = String(ctx.args.command ?? "");
  const program = secretEnvProgram(command);
  const outcome = await getApprovalManager().requestApprovalDetailed({
    toolName: SECRET_USE_TOOL,
    toolCallId: ctx.tc.id,
    sessionId: ctx.sessionId || "default",
    context:
      `Let \`${program}\` use ${names.join(", ")}?\n\n${command}\n\n` +
      `The value goes into this command's environment only — never into the command text, and never to the model; ` +
      `anything the command prints has it removed. "Always allow" covers ${program} with ${names.length === 1 ? "this secret" : "these secrets"} only.`,
    args: { program, secrets: names },
    opId: ctx.operationId,
    emit: ctx.onEvent,
  });
  return outcome.approved ? { kind: "continue" } : { kind: "denied", reason: outcome.reason };
}
