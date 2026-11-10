/**
 * The files a shell command changed without naming them (`sed -i`, a build
 * step, a code generator), for the claim check (claim-clash-gate.ts): the
 * checkout the command runs in is looked at before the session's first shell
 * command and after each one that ran to its end, and what changed between
 * looks is the session's (agency/tree-changes.ts).
 */
import { join } from "node:path";
import type { ToolCallContext } from "./context.js";
import { shellCommandOf, waitsForShellCommand } from "../tool-registry.js";
import { cwdOf } from "./internal-args.js";
import { shellRunDir } from "./create-target-path.js";
import { sessionWorkRootOf } from "../workspace/paths.js";
import { locateInRepo } from "../agency/repo-locate.js";
import { baselineTree, changedSinceLastLook } from "../agency/tree-changes.js";

type ShellCall = Pick<ToolCallContext, "tc" | "args" | "sessionId">;

/** The git checkout a call's shell command runs in, if it is one. */
function shellCheckout(ctx: ShellCall): string | null {
  const command = shellCommandOf(ctx.tc.name, ctx.args);
  if (!command || !ctx.sessionId || !waitsForShellCommand(ctx.tc.name)) return null;
  const cwd = cwdOf(ctx.args) ?? sessionWorkRootOf(ctx.sessionId);
  if (!cwd) return null;
  const place = locateInRepo(join(shellRunDir(command, cwd), ".look"));
  return place && !place.repoKey.startsWith("dir:") ? place.checkout : null;
}

/** Before a shell command runs: what the checkout looks like, if this session
 *  has not looked yet. */
export function baselineBeforeShell(ctx: ShellCall): void {
  try {
    const checkout = shellCheckout(ctx);
    if (checkout) baselineTree(ctx.sessionId!, checkout);
  } catch { /* coordination is best-effort */ }
}

/** After a shell command ran: the files that changed since the last look, absolute. */
export function pathsShellChanged(ctx: ShellCall): string[] {
  const checkout = shellCheckout(ctx);
  return checkout ? changedSinceLastLook(ctx.sessionId!, checkout).map((rel) => join(checkout, rel)) : [];
}
