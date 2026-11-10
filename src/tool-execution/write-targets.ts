/**
 * The files a tool call would write or delete, resolved as the tool resolves
 * them: every non-read path the policy table declares for the tool
 * (TOOL_PATH_ARGS, the specs the file-access gate confines), the original a
 * restore_file brings back, and a shell command's own write targets (a
 * redirect, a cp/mv destination, an rm operand). Read by the control-file gate
 * (control-file-gate.ts) and the claim check (claim-clash-gate.ts, ADR 0007),
 * so both judge the same set.
 *
 * What a shell command writes some other way (`sed -i`, a build step, a code
 * generator) is not seen here.
 */
import type { ToolCallContext } from "./context.js";
import { declaredPaths, pathSpecsForCall, shellCommandOf } from "../tool-registry.js";
import { resolveAgentPath } from "../workspace/paths.js";
import { shellMutationTargets } from "../security/layer/shell-mutation-guard.js";
import { findTrashEntry } from "../trash-journal.js";
import { restoreRef } from "../tools/restore-file-tool.js";

export interface WriteTarget { path: string; deletes: boolean }

export function writeTargets(ctx: Pick<ToolCallContext, "tc" | "args" | "sessionId">): WriteTarget[] {
  const { name } = ctx.tc;
  const out: WriteTarget[] = [];
  for (const spec of pathSpecsForCall(name, ctx.args)) {
    if (spec.action === "read") continue;
    // A non-string element is refused by the file-access gate before this runs.
    for (const raw of declaredPaths(ctx.args, spec) ?? []) {
      out.push({ path: resolveAgentPath(raw, ctx.sessionId), deletes: spec.action === "delete_file" });
    }
  }
  if (name === "restore_file") {
    const original = findTrashEntry(restoreRef(ctx.args), { kind: "file" })?.original;
    if (original) out.push({ path: original, deletes: false });
  }
  // A shell command's own write targets — a redirect, a cp/mv destination, an
  // rm operand — are judged the same way the file tools' paths are, so the
  // card asks about `echo … > ~/.lax/hooks.json` as it asks about a `write`.
  const command = shellCommandOf(name, ctx.args);
  if (command) {
    for (const { path, verb } of shellMutationTargets(command)) {
      out.push({ path, deletes: verb === "rm" || verb === "unlink" || verb === "shred" });
    }
  }
  return out;
}
