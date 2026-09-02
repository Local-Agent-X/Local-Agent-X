import { basename } from "node:path";
import { resolveAgentPath, sessionIdOf } from "../workspace/paths.js";
import { restoreFromTaskTrash } from "../safe-delete.js";
import { recordTaskArtifact } from "../data-lineage/task-artifacts.js";
import type { ToolDefinition } from "../types.js";
import { ok, err } from "./result-helpers.js";

/**
 * restore_file — the inverse leg of delete_file's task-trash route.
 *
 * delete_file moves an AGENT-CREATED file (task-artifact registry hit) into
 * the session's task-trash scope instead of the OS Trash, and its result text
 * promises `restore_file({ path: "<absolute original path>" })`. This tool
 * keeps that promise: it calls restoreFromTaskTrash (safe-delete.ts) for the
 * trusted session and surfaces its { restored } / { error } contract as the
 * ok/err envelope — the error strings are safe-delete's own, already written
 * to be model-surfaceable.
 *
 * The ABSOLUTE original path is the primary contract on purpose: the policy
 * table write-gates both args, and in confined file-access modes a bare
 * basename resolves OUTSIDE the workspace (project-root anchoring) and is
 * blocked before the restore ever runs. Bare basename / in-trash-name refs
 * remain a documented convenience for unrestricted mode only.
 *
 * On success the restored path is RE-ENROLLED in the task-artifact registry:
 * delete_file un-enrolled it when the bytes left the world, so the shell
 * hard-delete deny (shell-path-guard) must start covering it again the moment
 * the bytes are back.
 */
export const restoreFileTool: ToolDefinition = {
  name: "restore_file",
  description:
    "Restore a file that delete_file moved to the task trash (agent-created files deleted during THIS task), byte-identical, back to the path it was deleted from. " +
    "Pass `path` as the ABSOLUTE original path exactly as printed in delete_file's result — that spelling works in every file-access mode. (A bare basename or in-trash name also matches, but only in unrestricted mode: confined modes resolve a bare name outside the workspace and block the call before the restore runs.) " +
    "When the same name was deleted more than once, the most recent delete wins. " +
    "Refuses to overwrite a file that now exists at the original path — move or delete that file first, then restore again. " +
    "`destination` is ONLY for recovered entries (a restore error saying the original path was lost when the manifest was recovered): pass the full ABSOLUTE path to restore to, and it MUST keep the trashed file's basename — a recovered entry only matches a destination sharing that basename, so a different file name matches nothing. " +
    "Only works until the task's trash scope closes; user files deleted with delete_file go to the OS Trash instead and are not restorable here.",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "The deleted file's ABSOLUTE original path (from delete_file's result). Bare basename / in-trash name work in unrestricted mode only." },
      destination: { type: "string", description: "Recovered entries only: absolute path to restore to (must keep the trashed file's basename)" },
    },
    required: ["path"],
  },
  async execute(args) {
    const sid = sessionIdOf(args);
    if (!sid) {
      return err("restore_file has no session context, so there is no task-trash scope to look in. Nothing was restored.");
    }
    const rawPath = String(args.path);
    const rawDest = typeof args.destination === "string" && args.destination ? args.destination : undefined;
    // A bare name (no directory part) is a basename / in-trash-name reference
    // and must reach safe-delete UNRESOLVED — anchoring it at the workspace
    // would defeat restoreFromTaskTrash's basename matching. Anything with a
    // directory part (or ~) resolves through the same resolver every other
    // file tool and the security gate use. An explicit destination is always
    // resolved: safe-delete treats a ref with a directory part as the restore
    // target for recovered entries.
    //
    // Gate/target honesty: the pre-dispatch write gate evaluated the CALLER-
    // SUPPLIED arg spellings (path/destination), while the path actually
    // written for a non-recovered entry is the manifest's recorded `original`.
    // That is safe, not a bypass: `original` was created by a gated
    // create-class write under this same confinement (and delete_file's gate
    // checked the identical path again on the way into the trash), so the
    // restore target has already passed the exact boundary this call's arg
    // just passed.
    const ref = rawDest !== undefined
      ? resolveAgentPath(rawDest, sid)
      : /[\\/]/.test(rawPath) || rawPath.startsWith("~")
        ? resolveAgentPath(rawPath, sid)
        : rawPath;
    const result = restoreFromTaskTrash(sid, ref);
    if ("error" in result) return err(result.error, { path: rawPath });
    // Registry coherence: the restored bytes are the agent's artifact again —
    // re-enroll so the delete protections (delete_file's task-trash routing,
    // the shell rm deny) cover the file exactly as before its deletion.
    recordTaskArtifact(sid, result.restored);
    return ok(`Restored ${result.restored} from the task trash${basename(result.restored) !== basename(rawPath) ? ` (matched via "${rawPath}")` : ""}.`);
  },
};
