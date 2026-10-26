// A write to a file that is later carried out rather than just kept is put to
// the user, never made silently. Two kinds: the app's own files in its data
// dir (everything there but the agent's working data: see
// laxApprovalGatedFile), which the app reads back as settings, schedules,
// code it loads, programs it runs and memory it reads into every chat; and
// the login, terminal and git startup files in the user's own folders (see
// persistence-locations.ts), which run outside every cage. A prompt-injected
// write to either is code execution later. The user can still have the
// change made by asking: the card names the file and what it controls, and
// an unattended run, with nobody to ask, is refused (require-approval.ts). A
// file the user named in this turn's message is the change they asked for,
// and asks nothing while the session has read nothing off-box.
//
// The targets are every non-read path the policy table declares for the tool
// (TOOL_PATH_ARGS, the specs the file-access gate confines, delete included),
// resolved as the tool resolves them; the classifiers then name the file each
// reaches on disk. bulk_replace discovers the rest of its targets under its
// declared root and skips both kinds itself (edit-tools.ts).
// restore_file writes the original its trash-journal entry records, which a
// same-basename ref reaches from any directory, so that original is a target
// too.

import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import { relative } from "node:path";
import type { ToolCallContext } from "./context.js";
import { declaredPaths, pathSpecsForCall, shellCommandOf } from "../tool-registry.js";
import { resolveAgentPath } from "../workspace/paths.js";
import { laxApprovalGatedFile } from "../security/layer/lax-control-files.js";
import { shellMutationTargets } from "../security/layer/shell-mutation-guard.js";
import { persistenceLocationJudge, type PersistenceLocationOf } from "../security/layer/persistence-locations.js";
import { pathIsWithin } from "../security/layer/file-access.js";
import { findTrashEntry } from "../trash-journal.js";
import { restoreRef } from "../tools/restore-file-tool.js";
import { hasExternalIngestion } from "../data-lineage/external.js";
import { currentHumanText, userNamedFile } from "./unnamed-delete-gate.js";

function writeTargets(ctx: ToolCallContext): Array<{ path: string; deletes: boolean }> {
  const { name } = ctx.tc;
  const out: Array<{ path: string; deletes: boolean }> = [];
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

function gatedFile(path: string, startupFileOf: PersistenceLocationOf): { path: string; controls: string } | null {
  const lax = laxApprovalGatedFile(path);
  if (lax) return lax;
  const startup = startupFileOf(path);
  return startup && { path: startup.path, controls: startup.runs };
}

function shown(p: string): string {
  for (const home of [homedir(), realpathSync.native(homedir())]) {
    if (pathIsWithin(home, p)) return `~/${relative(home, p).replace(/\\/g, "/")}`;
  }
  return p;
}

/** What the person at the keyboard wrote this turn, when it can vouch for a
 *  file: attended runs only, and never once the session has read off-box
 *  content. "Add an alias to my .bashrc" names the file, but a page read in
 *  the same session could have written the alias, so the card is what puts
 *  that content in front of the user. */
function vouchingText(ctx: ToolCallContext): string {
  if (ctx.callContext !== "local" || hasExternalIngestion(ctx.sessionId || "default")) return "";
  return currentHumanText(ctx.priorMessages);
}

export function controlFileGate(ctx: ToolCallContext): void {
  const targets = writeTargets(ctx);
  // Every tool call passes here, and naming the startup locations on disk
  // costs a few milliseconds that a call writing nothing need not pay.
  if (targets.length === 0) return;
  const startupFileOf = persistenceLocationJudge();
  const said = vouchingText(ctx);
  for (const target of targets) {
    const file = gatedFile(target.path, startupFileOf);
    if (!file) continue;
    // The user named this exact file (a folder or a pattern names none): the
    // card would ask whether they asked for the change they just asked for
    // (Peter's call, 2026-10-26). Every other gated target still asks.
    if (said && (userNamedFile(said, target.path) || userNamedFile(said, file.path))) continue;
    const reason = `This ${ctx.tc.name} call ${target.deletes ? "deletes" : "changes"} ${shown(file.path)}, which ${file.controls}. `
      + "Approve it only if you asked for this change.";
    if (!ctx.policyApprovalReason) ctx.policyApprovalReason = reason;
    else if (!ctx.policyApprovalReason.includes(reason)) ctx.policyApprovalReason += `; ${reason}`;
  }
}
