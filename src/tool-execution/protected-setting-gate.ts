/**
 * The consent gate for user-owned controls.
 *
 * A "protected" setting (settings-schema.ts `protected: true`) is the user's
 * leash on the agent: the tool kill-switches, the approval mode, browser
 * identity/secrecy, remote control, strict local-only mode, and developer_mode.
 * The spending caps are the user's leash on the agent's spending. The
 * invariant this module owns is one sentence:
 *
 *     The agent may REQUEST a user-owned control change that widens what it
 *     may do or spend. It may never self-apply one.
 *
 * A change that can only narrow the agent (settings-change-direction.ts)
 * applies without a card: asking the user to approve the agent turning its
 * own shell off, or lowering a cap, tells them nothing they need to decide.
 *
 * Enforcement lives here rather than inline in the gate chain so there is a
 * single named choke point every mutation path can be tested against — see
 * user-owned-controls.contract.test.ts, which enumerates PROTECTED_SETTINGS
 * and asserts each seam is covered.
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
import { currentSettingValue, isUserOwnedSetting, strictlyTightens } from "../settings-change-direction.js";
import { SPENDING_CAP_SETTINGS } from "../settings-schema.js";

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

/** The user-owned setting a `setting` call changes, or null for any other call. */
export function userOwnedFieldOf(call: GateCall): string | null {
  if (call.name !== "setting") return null;
  const field = String((call.args as { field?: unknown }).field ?? "");
  return isUserOwnedSetting(field) ? field : null;
}

const usd = (amount: unknown): string => (typeof amount === "number" && amount > 0 ? `$${amount}` : "no cap");

/** Plain-English approval prompt for a change that widens the agent. The user
 *  is not reading the schema, so name the concrete capability or money being
 *  handed over, not the field id. A narrowing change never gets here. */
export function describeChange(field: string, value: unknown, current: unknown): string {
  switch (field) {
    case "developer_mode":
      return "Turn on developer mode? It lets the agent change Local Agent X's own source code: it unlocks self_edit and autopilot, and this install then has to merge its local edits into every official update. It stays on until you turn it off in Settings → Security → Developer Mode.";
    case "localOnlyMode":
      return "Turn off strict local-only mode and restore remote network access (cloud models, web tools, sync and updates)?";
    case "toolApproval":
      return `Change when the agent must ask your permission before running tools (toolApproval → "${String(value)}")?`;
    case "enableShell":
      return "Allow the agent to run shell commands (enableShell)?";
    case "enableHttp":
      return "Allow the agent to make HTTP requests (enableHttp)?";
    case "enableBrowser":
      return "Allow the agent to drive the browser (enableBrowser)?";
    case "enableComputerControl":
      return "Allow the agent to control your mouse and keyboard (enableComputerControl)?";
    case "enableRemoteControl":
      return "Allow a paired phone to drive your mouse and keyboard (enableRemoteControl)?";
    case "supervisedBrowser":
      return "Let browser.evaluate run without asking (supervisedBrowser off)?";
    case "browserSecrecy":
      return `Change the agent's sensitive-page read policy (browserSecrecy → "${String(value)}")?`;
    case "browserMode":
      return `Change the browser identity mode (browserMode → "${String(value)}")?`;
    case "learningMode":
      return `Change how newly learned skills activate (learningMode → "${String(value)}")?`;
    case "skillReviewEnabled":
      return "Resume reviewing finished turns for reusable procedures (skillReviewEnabled)?";
    case "enableUiEventBus":
      return "Let your UI activity be summarized into the agent's context (enableUiEventBus)?";
    case "dailyBudgetUsd":
      return `Change the daily spending cap on API-key usage from ${usd(current)} to ${usd(value)}?`;
    case "sessionBudgetUsd":
      return `Change the per-session spending cap on API-key usage from ${usd(current)} to ${usd(value)}?`;
    case "modelDailyBudgetsUsd":
      return `Raise or remove a per-model daily spending cap (modelDailyBudgetsUsd → ${JSON.stringify(value)}, now ${JSON.stringify(current ?? {})})?`;
    default:
      return `Change the user-owned setting "${field}" to ${JSON.stringify(value)}?`;
  }
}

/**
 * Enforce the consent invariant for a `setting` call.
 *
 * Returns "not-protected" when the call is none of our business, "tightens"
 * when the change can only narrow the agent (the caller then gates it like any
 * other setting), or "approved" when the user said yes. Throws
 * ProtectedSettingDenied otherwise. A return of "approved" is terminal — the
 * caller skips the generic autonomy-profile gate, because a fresh explicit
 * approval already outranks the profile table.
 */
export async function enforceProtectedSettingGate(
  call: GateCall,
  ctx: GateCtx,
  approvalManager: GateApprovalManager,
  readCurrent: (field: string) => unknown = currentSettingValue,
): Promise<"not-protected" | "tightens" | "approved"> {
  const field = userOwnedFieldOf(call);
  if (!field) return "not-protected";
  const value = (call.args as { value?: unknown }).value;
  if (strictlyTightens(field, value, () => readCurrent(field))) return "tightens";

  // No user present — never, under any profile. This is the hard guarantee for
  // cron / API / delegated sub-agent runs.
  if (ctx.callContext !== "local") {
    throw new ProtectedSettingDenied(
      `"${field}" is a user-owned setting and cannot be widened in an automated/background run.`,
      "User-owned settings widen only when the user approves in an interactive chat. Report what you need and why, and let the user decide.",
    );
  }

  // Interactive, but no approval channel wired (headless bridge, MCP host).
  // Without a way to ask, the answer is no.
  if (!ctx.approval) {
    throw new ProtectedSettingDenied(
      `"${field}" is a user-owned setting and this session has no way to ask for approval.`,
      `Tell the user to change it themselves in ${SPENDING_CAP_SETTINGS.has(field) ? "Settings → Usage → Spending limits" : "Settings"}.`,
    );
  }

  // alwaysAsk: a remembered "allow" grant or a permissive autonomy profile must
  // NOT auto-approve handing over a security control or the user's money.
  // Every time, explicitly.
  const approved = await approvalManager.requestApproval({
    toolName: call.name,
    toolCallId: call.id,
    sessionId: ctx.sessionId,
    context: describeChange(field, value, readCurrent(field)),
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
