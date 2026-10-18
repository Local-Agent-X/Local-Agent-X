/**
 * Handing a vault secret to a command (`secret_env` on any tool in
 * SECRET_ENV_TOOLS: bash, process_start, process_restart) is the profile's
 * `secrets` risk class: Safe refuses, Normal and Power ask once per
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
import { paidMediaSecretEnvRefusal, SECRET_ENV_TOOLS, secretEnvOf, secretEnvProgram } from "../tools/shell-secret-env.js";
import { spawnCommandOf } from "../tools/process-session.js";
import type { ToolCallContext } from "./context.js";
import { parkOrRefuse, takeUserGrant } from "./deferred-call.js";

export const SECRET_USE_TOOL = "use_secret";

export type SecretEnvGate =
  | { kind: "continue" }
  | { kind: "blocked"; result: ToolResult }
  | { kind: "denied"; reason: ApprovalDenyReason | undefined };

export async function secretEnvGate(ctx: ToolCallContext): Promise<SecretEnvGate> {
  if (!SECRET_ENV_TOOLS.has(ctx.tc.name)) return { kind: "continue" };
  let secretEnv;
  try { secretEnv = secretEnvOf(ctx.args); } catch { return { kind: "continue" }; /* the tool reports the malformed arg */ }
  if (!secretEnv) return { kind: "continue" };

  const rule = getRiskDecision("secrets", ctx.sessionId);
  const names = [...new Set(Object.values(secretEnv))].sort();
  const blockedResult = (content: string, recovery: string): ToolResult =>
    ({ content, isError: true, status: "blocked", metadata: { layer: "approval", userHint: USER_HINTS.policy, recovery } });
  // A paid media key the Settings → Media switch keeps from the shell: refused
  // before anyone is asked, since no yes to the card can stand in for the switch.
  const paidMedia = paidMediaSecretEnvRefusal(secretEnv);
  if (paidMedia) {
    return { kind: "blocked", result: blockedResult(paidMedia,
      "For an image or video, use generate_image / generate_video with a signed-in backend, or tell the user the switch is off. For any other call to that provider, use http_request with {{SECRET_NAME}}: it judges the route, so a non-media call still goes through. Continue with the rest of the request.") };
  }
  if (decisionDenies(rule)) {
    return { kind: "blocked", result: blockedResult(`BLOCKED by profile: this profile does not let a vault secret (${names.join(", ")}) be handed to a command. Use http_request with {{SECRET_NAME}} in a header, or ask the user to run the command.`,
      "Send the secret with http_request and a {{SECRET_NAME}} placeholder, or give the user the command to run themselves. Continue with the rest of the request.") };
  }
  if (!decisionRequiresPrompt(rule)) return { kind: "continue" };
  // The user's yes to this exact call, given from the inbox, covers its secrets too.
  if (takeUserGrant(ctx)) return { kind: "continue" };
  if (ctx.callContext !== "local" || !ctx.onEvent) {
    const reason = `BLOCKED: handing ${names.join(", ")} to a command needs the user's yes under this profile, and no one can be asked on this run.`;
    const refusal = blockedResult(reason,
      "Send the secret with http_request and a {{SECRET_NAME}} placeholder if that fits; otherwise report the command as waiting for the user. Continue with the rest of the request.");
    return { kind: "blocked", result: parkOrRefuse(ctx, reason, refusal) };
  }

  const command = spawnCommandOf(ctx.args);
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
