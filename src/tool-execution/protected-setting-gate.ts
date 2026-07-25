/**
 * The consent gate for user-owned security controls.
 *
 * A "protected" setting (settings-schema.ts `protected: true`) is the user's
 * leash on the agent: the tool kill-switches, the approval mode, browser
 * identity/secrecy, remote control, strict local-only mode, and developer_mode.
 * The invariant this module owns is one sentence:
 *
 *     The agent may REQUEST a user-owned control change. It may never
 *     self-apply one.
 *
 * Enforcement lives here rather than inline in the gate chain so there is a
 * single named choke point every mutation path can be tested against — see
 * protected-setting-gate.test.ts, which enumerates PROTECTED_SETTINGS and
 * asserts each seam is covered.
 *
 * WHY THIS IS CODE AND NOT PROMPT TEXT
 * The previous rule was "the autonomous block is the hard guarantee; the
 * prompt-side rule keeps the agent from flipping one on its own initiative."
 * On 2026-07-25 an agent that had been firewalled out of an email task called
 * setting(developer_mode, true) on its own initiative, got `ok`, and opened a
 * self_edit worktree on its own source 25 seconds later. The system prompt
 * said, verbatim, that developer_mode "is a user-owned control you cannot flip
 * for them." Prose is not a control. This is.
 */
import type { ServerEvent } from "../types.js";
import { USER_HINTS } from "../types.js";
import { isProtectedSetting } from "../settings-schema.js";

/** Minimal shapes borrowed from pre-dispatch so this module stays leaf-level. */
interface GateCall {
  id: string;
  name: string;
  args: Record<string, unknown>;
}
interface GateCtx {
  sessionId: string;
  callContext: "local" | "api" | "delegated" | "cron";
  opId?: string;
  approval?: { onEvent: (event: ServerEvent) => void; context?: string };
}
interface GateApprovalManager {
  requestApproval(input: {
    toolName: string;
    toolCallId: string;
    sessionId: string;
    context: string;
    args: Record<string, unknown>;
    alwaysAsk: boolean;
    opId?: string;
    emit: (event: ServerEvent) => void;
  }): Promise<boolean>;
}

/** Raised on refusal. The caller re-throws as its own ToolBlocked so this
 *  module does not depend on the pre-dispatch error class (cycle-free). */
export class ProtectedSettingDenied extends Error {
  readonly reason: string;
  readonly recovery?: string;
  readonly userHint: string;
  constructor(reason: string, recovery?: string) {
    super(reason);
    this.name = "ProtectedSettingDenied";
    this.reason = reason;
    if (recovery !== undefined) this.recovery = recovery;
    this.userHint = USER_HINTS.policy;
  }
}

export function protectedFieldOf(call: GateCall): string | null {
  if (call.name !== "setting") return null;
  const field = String((call.args as { field?: unknown }).field ?? "");
  return isProtectedSetting(field) ? field : null;
}

/** Plain-English approval prompt. The user is not reading the schema, so name
 *  the concrete capability being handed over, not the field id. */
export function describeChange(field: string, value: unknown): string {
  const on = value === true;
  switch (field) {
    case "developer_mode":
      return on
        ? "Allow the agent to modify Local Agent X's own source code (developer_mode)? This unlocks self_edit and forks this install from official updates."
        : "Turn developer_mode off (agent can no longer self-edit its source)?";
    case "localOnlyMode":
      return value === false
        ? "Disable strict local-only mode and restore remote network access?"
        : "Enable strict local-only mode (loopback and local models only)?";
    case "toolApproval":
      return `Change when the agent must ask your permission before running tools (toolApproval → "${String(value)}")?`;
    case "enableShell":
      return on ? "Allow the agent to run shell commands (enableShell)?" : "Block all shell commands (enableShell off)?";
    case "enableHttp":
      return on ? "Allow the agent to make HTTP requests (enableHttp)?" : "Block all HTTP requests (enableHttp off)?";
    case "enableBrowser":
      return on ? "Allow the agent to drive the browser (enableBrowser)?" : "Block all browser tools (enableBrowser off)?";
    case "enableComputerControl":
      return on ? "Allow the agent to control your mouse and keyboard (enableComputerControl)?" : "Block mouse/keyboard control?";
    case "enableRemoteControl":
      return on ? "Allow a paired phone to drive your mouse and keyboard (enableRemoteControl)?" : "Block phone remote control?";
    case "supervisedBrowser":
      return on ? "Require your approval for browser.evaluate on untrusted pages (supervisedBrowser on)?" : "Let browser.evaluate run without asking (supervisedBrowser off)?";
    case "browserSecrecy":
      return `Change the agent's sensitive-page read policy (browserSecrecy → "${String(value)}")?`;
    case "browserMode":
      return `Change the browser identity mode (browserMode → "${String(value)}")?`;
    case "learningMode":
      return `Change how newly learned skills activate (learningMode → "${String(value)}")?`;
    case "enableUiEventBus":
      return on ? "Let your UI activity be summarized into the agent's context (enableUiEventBus)?" : "Stop feeding UI activity to the agent?";
    default:
      return `Change the user-owned security setting "${field}" to ${JSON.stringify(value)}?`;
  }
}

/**
 * Enforce the consent invariant for a `setting` call.
 *
 * Returns "not-protected" when the call is none of our business, or "approved"
 * when the user said yes. Throws ProtectedSettingDenied otherwise. A return of
 * "approved" is terminal — the caller skips the generic autonomy-profile gate,
 * because a fresh explicit approval already outranks the profile table.
 */
export async function enforceProtectedSettingGate(
  call: GateCall,
  ctx: GateCtx,
  approvalManager: GateApprovalManager,
): Promise<"not-protected" | "approved"> {
  const field = protectedFieldOf(call);
  if (!field) return "not-protected";

  // No user present — never, under any profile. This is the hard guarantee for
  // cron / API / delegated sub-agent runs.
  if (ctx.callContext !== "local") {
    throw new ProtectedSettingDenied(
      `"${field}" is a user-owned security setting and cannot be changed in an automated/background run.`,
      "Security settings change only when the user approves in an interactive chat. Report what you need and why, and let the user decide.",
    );
  }

  // Interactive, but no approval channel wired (headless bridge, MCP host).
  // Without a way to ask, the answer is no.
  if (!ctx.approval) {
    throw new ProtectedSettingDenied(
      `"${field}" is a user-owned security setting and this session has no way to ask for approval.`,
      "Tell the user to change it themselves in Settings → Security.",
    );
  }

  const value = (call.args as { value?: unknown }).value;
  // alwaysAsk: a remembered "allow" grant or a permissive autonomy profile must
  // NOT auto-approve handing over a security control. Every time, explicitly.
  const approved = await approvalManager.requestApproval({
    toolName: call.name,
    toolCallId: call.id,
    sessionId: ctx.sessionId,
    context: describeChange(field, value),
    args: call.args,
    alwaysAsk: true,
    ...(ctx.opId !== undefined ? { opId: ctx.opId } : {}),
    emit: ctx.approval.onEvent,
  });

  if (!approved) {
    throw new ProtectedSettingDenied(
      `The user did not approve changing "${field}".`,
      "Do not retry and do not look for another route to the same change. Continue without it, or stop and explain what you cannot do.",
    );
  }
  return "approved";
}
