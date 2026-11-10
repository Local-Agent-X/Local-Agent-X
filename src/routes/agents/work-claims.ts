/**
 * Who is working on what, for the agents panel (ADR 0007 §4).
 *
 *   GET /api/work-claims — every live holder (chats and workers): its task,
 *   the areas it claims, its state, and the other holders its claims overlap.
 *   With `?session=<id>`, also `others`: the agents working in that chat's
 *   project, for the strip in its window.
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
import { areasOf, reposOfSession } from "../../agency/other-agents-block.js";
import { normRepoPath, repoPathsOverlap } from "../../agency/path-overlap.js";
import { handleOwnCopyRoutes, ownCopyView } from "./own-copy.js";

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

function rowOf(h: HolderView, all: HolderView[]): WorkClaimRow {
  return {
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
  };
}

export function workClaimRows(): WorkClaimRow[] {
  const all = liveHolders();
  return all.map((h) => rowOf(h, all));
}

/** The other agents working in the repos `sessionId` works in, each flagged
 *  when its claims overlap that session's: the strip a chat window shows. */
export function othersInProjectOf(sessionId: string): Array<WorkClaimRow & { clashesWithMe: boolean }> {
  const repos = new Set(reposOfSession(sessionId));
  const all = liveHolders();
  const here = all.filter((h) => repos.has(h.repoKey) && h.state !== "recent");
  const mine = here.filter((h) => h.sessionId === sessionId);
  return here
    .filter((h) => h.sessionId !== sessionId)
    .map((h) => ({ ...rowOf(h, all), clashesWithMe: mine.some((m) => m.repoKey === h.repoKey && overlaps(h, m)) }));
}

export const handleWorkClaimRoutes: RouteHandler = async (method, url, req, res, ctx, role) => {
  if (await handleOwnCopyRoutes(method, url, req, res, ctx, role)) return true;
  if (method !== "GET" || url.pathname !== "/api/work-claims") return false;
  const session = url.searchParams.get("session");
  const forChat = session ? { others: othersInProjectOf(session), ownCopy: ownCopyView(ctx, session) } : {};
  jsonResponse(res, 200, { holders: workClaimRows(), ...forChat }, req);
  return true;
};

/** Tell open tabs when a holder changes. Called once at boot. */
export function wireWorkClaimsBroadcast(): void {
  setClaimsChangedListener(() => void import("../../chat-ws/index.js")
    .then(({ broadcastAll }) => broadcastAll({ type: "work_claims_changed" }))
    .catch(() => { /* no socket server (a child process, a test) */ }));
}
