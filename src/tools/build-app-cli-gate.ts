/**
 * Developer-mode gate for build_app's cli-subprocess strategy.
 *
 * That strategy hands the build to the codex or claude CLI on the host with
 * its approvals bypassed and Bash enabled, outside the cage: the same reach
 * over this machine that self_edit has. The app-builder template picks the
 * strategy, and a template is a file the agent can change, so the template
 * alone must never unlock it. build_app refuses up front, and the adapter
 * refuses again right before it spawns the CLI, because a build queued while
 * developer_mode was on can be leased after it was turned off (a queue wait,
 * a retry, a restore after restart). Refusing, never quietly building
 * in-canonical instead: the template says CLI, so the user decides.
 */
import { getSetting, onSettingsSaved } from "../settings.js";
import { listOps } from "../ops/op-store.js";
import { OP_TYPE } from "../ops/op-types.js";
import { isTerminalState } from "../canonical-loop/index.js";

/** The refusal to return instead of running a CLI build, or null when developer_mode is on. */
export function cliBuildDeveloperModeRefusal(provider: string): string | null {
  if (getSetting("developer_mode") === true) return null;
  return (
    `BLOCKED — the app-builder template pins ${provider} builds to the cli-subprocess strategy, which runs the codex or claude CLI ` +
    "directly on this machine with its approvals bypassed and shell access, outside the sandbox. That requires developer_mode (currently off). " +
    "Nothing was built.\n\n" +
    "Tell the user, and let them choose:\n" +
    "- Build the normal way, inside Local Agent X's own tool checks: remove the cli-subprocess pin from the app-builder template's providerStrategy, then retry.\n" +
    "- Keep the CLI build: turn on developer_mode in Settings. It's a user-owned control you cannot flip for them. " +
    "Tell them the trade-off: with developer_mode on, a CLI build has the same unrestricted reach over this machine as self_edit."
  );
}

/** Every CLI build still queued or running: a cancel reaches its adapter, which
 *  kills the CLI's process tree. Returns the ids cancelled. */
export async function cancelCliBuildsIfDeveloperModeOff(): Promise<string[]> {
  if (getSetting("developer_mode") === true) return [];
  const { opCancel } = await import("../canonical-loop/index.js");
  const cancelled: string[] = [];
  for (const op of listOps()) {
    const descriptor = op.runtimeDescriptor;
    if (op.type !== OP_TYPE.appBuild || descriptor?.kind !== "app-build" || descriptor.strategy !== "cli-subprocess") continue;
    if (isTerminalState(op.canonical?.state)) continue;
    if (opCancel(op.id, "developer_mode_off").ok) cancelled.push(op.id);
  }
  return cancelled;
}

// Only the flip itself is acted on: the sweep reads every persisted op.
onSettingsSaved((next, prev) => {
  if (prev.developer_mode === true && next.developer_mode !== true) void cancelCliBuildsIfDeveloperModeOff();
});
