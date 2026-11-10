/**
 * Who is working on what, for the agents panel (ADR 0007 §4).
 *
 *   GET /api/work-claims — every live holder (chats and workers): its task,
 *   the areas it claims, its state, and the other holders its claims overlap.
 *
 * Open tabs are told to re-read it by a `work_claims_changed` frame whenever
 * a holder changes in this process; the panel also re-reads on a timer, which
 * covers a worker in a child process and a state that changes with time alone
 * (working → between messages → lately).
 */
import { basename } from "node:path";
import type { RouteHandler } from "../../server-context.js";
import { jsonResponse } from "../../server-utils.js";
import { liveHolders, setClaimsChangedListener, type HolderView } from "../../agency/work-claims.js";
import { areasOf } from "../../agency/other-agents-block.js";
import { normRepoPath, repoPathsOverlap } from "../../agency/path-overlap.js";

export interface WorkClaimRow {
  sessionId: string;
  opId: string | null;
  kind: HolderView["kind"];
  displayName: string;
  task: string;
  state: HolderView["state"];
  /** The folder it writes, by name: a worktree or the project folder. */
  folder: string;
  areas: string[];
  /** Other holders in the same repo whose claims overlap this one's. */
  clashesWith: string[];
}

function overlaps(a: HolderView, b: HolderView): boolean {
  return a.claims.some((x) => b.claims.some((y) => repoPathsOverlap(normRepoPath(x.path), normRepoPath(y.path))));
}

export function workClaimRows(): WorkClaimRow[] {
  const all = liveHolders();
  return all.map((h) => ({
    sessionId: h.sessionId,
    opId: h.opId ?? null,
    kind: h.kind,
    displayName: h.displayName,
    task: h.task,
    state: h.state,
    folder: basename(h.checkout),
    areas: areasOf(h),
    clashesWith: all
      .filter((o) => o !== h && o.repoKey === h.repoKey && o.state !== "recent" && overlaps(h, o))
      .map((o) => o.displayName),
  }));
}

export const handleWorkClaimRoutes: RouteHandler = async (method, url, req, res) => {
  if (method !== "GET" || url.pathname !== "/api/work-claims") return false;
  jsonResponse(res, 200, { holders: workClaimRows() }, req);
  return true;
};

/** Tell open tabs when a holder changes. Called once at boot. */
export function wireWorkClaimsBroadcast(): void {
  setClaimsChangedListener(() => void import("../../chat-ws/index.js")
    .then(({ broadcastAll }) => broadcastAll({ type: "work_claims_changed" }))
    .catch(() => { /* no socket server (a child process, a test) */ }));
}
