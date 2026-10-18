// A `_` key is the server's channel to a tool (_cwd, _sessionId, _operationId,
// _onProgress, _lastUserMessage, …). The server stamps them after the model
// has spoken, and the tools trust them because of that. So every object the
// model wrote loses its `_` keys before it becomes a tool's arguments: the
// call's own arguments at dispatch (resolve-tool.ts), and any nested object a
// tool spreads into the arguments it hands on (a collapsed family's `params`,
// an op_submit_batch task). The trusted stamps are applied after, never under.
//
// A tool reads a stamp through the accessor below for it, never `args._x`
// (internal-args.test.ts scans for that): one place says what each stamp is
// and how an absent or malformed one reads, so a reader cannot drift from the
// writer, and the stamps a call carries never count as its identity
// (withoutInternalArgs: the journal fingerprint, the kernel bridge, the
// approval card).
import type { ServerEvent } from "../types.js";
import type { CallContext } from "./context.js";

const CALL_CONTEXTS: readonly CallContext[] = ["local", "api", "delegated", "cron"];

/** Whether `key` is a server-stamped argument name rather than a model one. */
export function isInternalArgKey(key: string): boolean {
  return key.startsWith("_");
}

/** A copy of a model-written object without any server-channel keys. */
export function withoutInternalArgs(modelArgs: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(modelArgs).filter(([key]) => !isInternalArgKey(key)));
}

type Args = Record<string, unknown>;

const text = (value: unknown): string | undefined => (typeof value === "string" && value ? value : undefined);
const fn = <T>(value: unknown): T | undefined => (typeof value === "function" ? (value as T) : undefined);

/** The session the dispatcher ran this call in — the one the file-access gate
 *  resolved its paths with, so every sink resolves with the same one. Stamped
 *  on SESSION_SCOPED_TOOLS and every tool with policy pathArgs (resolve-tool.ts). */
export function sessionIdOf(args: Args): string | undefined {
  return text(args._sessionId);
}

/** The operation the call belongs to (OPERATION_SCOPED_TOOLS). */
export function operationIdOf(args: Args): string | undefined {
  return text(args._operationId);
}

/** The id of this tool call, for a card that must resolve against it. */
export function toolCallIdOf(args: Args): string | undefined {
  return text(args._toolCallId);
}

/** Where the call came from (stamped on every dispatched call). */
export function callContextOf(args: Args): CallContext | undefined {
  return CALL_CONTEXTS.find((c) => c === args._callContext);
}

/** True when no person is watching the run this call belongs to: a gate
 *  inside the tool that would show a card returns a needs-you result instead
 *  (deferred-call.ts needsUser), and the pipeline parks it. An unstamped call
 *  (a direct caller) reads as attended, as before the stamp existed. */
export function unattendedCall(args: Args): boolean {
  const context = callContextOf(args);
  return context !== undefined && context !== "local";
}

/** The user's one-shot yes to this exact call, given from the inbox and taken
 *  by the pipeline before execute (run-sandboxed.ts): a gate inside the tool
 *  that would ask a person proceeds on it. */
export function userGrantOf(args: Args): string | undefined {
  return text(args._userGrant);
}

/** The session's event sink: progress, cards, warnings. Stamped on every
 *  dispatched call; undefined on a path with no listener (a harness command). */
export function onEventOf(args: Args): ((event: ServerEvent) => void) | undefined {
  return fn<(event: ServerEvent) => void>(args._onEvent);
}

/** The runner's progress line sink (tool-runner.ts). */
export function onProgressOf(args: Args): ((message: string) => void) | undefined {
  return fn<(message: string) => void>(args._onProgress);
}

/** The working directory a shell or self_edit was anchored at: a worktree
 *  (enforce-policy.ts), an autopilot checkout, a work root (resolve-tool.ts). */
export function cwdOf(args: Args): string | undefined {
  return text(typeof args._cwd === "string" ? args._cwd.trim() : undefined);
}

/** The user message a memory write answers (USER_MESSAGE_SOURCED_TOOLS). */
export function userMessageIdOf(args: Args): string | undefined {
  return text(args._userMessageId);
}

/** The last exchange before a self_edit, for its intent gate. */
export function lastTurnOf(args: Args): { user: string; assistant: string } {
  return { user: text(args._lastUserMessage) ?? "", assistant: text(args._lastAssistantMessage) ?? "" };
}

/** The provider and model the chat turn runs on, for a build that should use
 *  the same (plugins.ts bindBuildAppRuntime). */
export function runtimeOf(args: Args): { provider?: string; model?: string } {
  return { provider: text(args._runtimeProvider), model: text(args._runtimeModel) };
}

/** A browser download approval the gate bound for the page action that
 *  follows (browser-tools/gates.ts → page.ts); typed by its one reader. */
export function downloadApprovalOf<T>(args: Args): T | undefined {
  return args._downloadApproval === undefined ? undefined : (args._downloadApproval as T);
}
