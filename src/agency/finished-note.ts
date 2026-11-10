/**
 * When a worker's run ends, the other agents in its project are told what it
 * changed (ADR 0007 §3): a `finished` hand-over note per repo it wrote in,
 * naming its task and files. A run whose branch just merged already said so
 * (merge-overlap.ts `noteMerged`), and is not announced twice.
 *
 * Called where a run's workspace is released (agent-workspace.ts), once per run.
 */
import { holdersOfSession } from "./work-claims.js";
import { notesSince, postNote } from "./handover-notes.js";

const MERGED_JUST_NOW_MS = 2 * 60_000;
const announced = new Set<string>();
const ANNOUNCED_CAP = 2_000;

export function noteRunFinished(sessionId: string): void {
  if (announced.has(sessionId)) return;
  if (announced.size >= ANNOUNCED_CAP) announced.clear();
  announced.add(sessionId);
  try {
    for (const h of holdersOfSession(sessionId)) {
      const written = h.claims.filter((c) => c.source === "written").map((c) => c.path);
      if (written.length === 0) continue;
      const since = new Date(Date.now() - MERGED_JUST_NOW_MS).toISOString();
      const merged = notesSince(h.repoKey, since).some((n) => n.kind === "merged" && n.sessionId === sessionId);
      if (merged) continue;
      postNote({
        sessionId, displayName: h.displayName, repoKey: h.repoKey, paths: written, kind: "finished",
        text: `Finished${h.task ? `: ${h.task}` : ""}. Changed ${written.length} file(s) in ${h.checkout.replace(/\\/g, "/").split("/").pop()}.`,
      });
    }
  } catch { /* the run already ended; a note that could not be posted changes nothing */ }
}

/** Test seam. */
export function _resetFinishedNotesForTest(): void {
  announced.clear();
}
