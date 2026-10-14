import { basename } from "node:path";
import { resolveAgentPath, sessionIdOf } from "../workspace/paths.js";
import { restoreDeleted } from "../trash-restore.js";
import { recordTaskArtifact } from "../data-lineage/task-artifacts.js";
import type { ToolDefinition } from "../types.js";
import { ok, err } from "./result-helpers.js";

/**
 * The ref restore_file hands to restoreDeleted. Exported so the control-file
 * gate looks up the same journal entry this call will restore: the file
 * written is the journalled original, which a same-basename ref reaches from
 * anywhere.
 *
 * A bare name (no directory part) is a basename / in-trash-name reference and
 * must reach safe-delete UNRESOLVED — anchoring it at the workspace would
 * defeat restoreFromTaskTrash's basename matching. Anything with a directory
 * part (or ~) resolves through the same resolver every other file tool and
 * the security gate use. An explicit destination is always resolved:
 * safe-delete treats a ref with a directory part as the restore target for
 * recovered entries.
 */
export function restoreRef(args: Record<string, unknown>): string {
  const sid = sessionIdOf(args);
  const rawPath = String(args.path);
  const rawDest = typeof args.destination === "string" && args.destination ? args.destination : undefined;
  if (rawDest !== undefined) return resolveAgentPath(rawDest, sid);
  return /[\\/]/.test(rawPath) || rawPath.startsWith("~") ? resolveAgentPath(rawPath, sid) : rawPath;
}

/**
 * restore_file — the inverse leg of every delete_file route.
 *
 * delete_file's result text promises `restore_file({ path: "<absolute
 * original path>" })`. This tool keeps that promise: it calls restoreDeleted
 * (trash-restore.ts), which reads the trash journal to find which tier holds
 * the bytes — the OS bin, the app trash or the session's task trash — and
 * surfaces its { restored } / { error } contract as the ok/err envelope; the
 * error strings are already written to be model-surfaceable.
 *
 * The ABSOLUTE original path is the primary contract: the policy table
 * write-gates both args, and that spelling is what the gate checks. A bare
 * basename is gated as a workspace path and restores the most recent journal
 * match for that name.
 *
 * On success the restored path is RE-ENROLLED in the task-artifact registry:
 * delete_file un-enrolled it when the bytes left the world, so the shell
 * hard-delete deny (shell-path-guard) must start covering it again the moment
 * the bytes are back.
 */
export const restoreFileTool: ToolDefinition = {
  name: "restore_file",
  compactDescription: "Bring back a file or folder that delete_file moved to the trash. Pass `path` as the absolute original path printed in delete_file's result.",
  description:
    "Bring back a file or folder that delete_file moved to the trash, byte-identical, to the path it was deleted from. " +
    "delete_file records where every deletion went, and this restores from whichever trash holds it: the OS Recycle Bin / Trash (the user's own files), Local Agent X's own trash (a whole folder, or a file the Recycle Bin would not hold — kept 30 days), or the task trash (a file this task's agent created — restorable until the task ends). " +
    "Pass `path` as the ABSOLUTE original path exactly as printed in delete_file's result — that spelling works in every file-access mode. A bare basename also works and restores the MOST RECENT deletion of that name; an in-trash name matches a task-trash entry. " +
    "Refuses to overwrite a file that now exists at the original path — move or delete that file first, then restore again. " +
    "`destination` is ONLY for recovered entries (a restore error saying the original path was lost when the manifest was recovered): pass the full ABSOLUTE path to restore to, and it MUST keep the trashed file's basename — a recovered entry only matches a destination sharing that basename, so a different file name matches nothing.",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "The deleted file's ABSOLUTE original path (from delete_file's result), or a bare basename (restores the most recent deletion of that name)." },
      destination: { type: "string", description: "Recovered entries only: absolute path to restore to (must keep the trashed file's basename)" },
    },
    required: ["path"],
  },
  async execute(args) {
    // A session is required only for the task tier; a journalled deletion to
    // the OS bin or the ~/.lax trash restores without one.
    const sid = sessionIdOf(args);
    const rawPath = String(args.path);
    // Gate/target honesty: the pre-dispatch write gate evaluated the CALLER-
    // SUPPLIED arg spellings (path/destination), while the path actually
    // written for a non-recovered entry is the recorded `original`. For
    // confinement that is safe, not a bypass: the bytes go back to the path
    // they were deleted from, and the records naming that path cannot be
    // rewritten without the user's yes (laxApprovalGatedFile). Whether it is
    // a file the app acts on is judged on the journalled original itself
    // (control-file-gate.ts).
    const result = restoreDeleted(restoreRef(args), sid ? { sessionId: sid } : {});
    if ("error" in result) {
      // Without a session the task tier is unreachable, and that is usually
      // the real reason a restore found nothing — say so rather than leaving
      // the caller to infer it from "nothing matched".
      const why = sid ? "" : " This call had no session context, so the task trash could not be searched.";
      return err(`${result.error}${why}`, { path: rawPath });
    }
    // Registry coherence, TASK TIER ONLY: those bytes are the agent's artifact
    // again, so re-enroll and the delete protections (task-trash routing, the
    // shell rm deny) cover the file exactly as before. A USER file restored
    // from the OS bin was never an artifact — enrolling it here would quietly
    // hand the agent's protections to a file the user owns.
    if (result.tier === "task" && sid) recordTaskArtifact(sid, result.restored);
    const where = result.tier === "task" ? "the task trash" : result.tier === "lax" ? "the LAX trash" : "the system Trash";
    return ok(`Restored ${result.restored} from ${where}${basename(result.restored) !== basename(rawPath) ? ` (matched via "${rawPath}")` : ""}.`);
  },
};
