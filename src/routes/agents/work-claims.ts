/**
 * Who is working on what, for the agents panel (ADR 0007 §4).
 *
 *   GET /api/work-claims — every holder working now or between messages
 *   (chats and workers): its task, the areas it claims, its state, and the
 *   other holders its claims overlap. One that has finished is not listed:
 *   the strip says who is working, and a finished worker sat in it for two
 *   hours with nothing to open or clear.
 *   With `?session=<id>`, also `others`: the agents working in that chat's
 *   project, for the strip in its window; and `mine`: that chat and the agents
 *   it started, which with `others` is what the panel lists for one chat.
 *
 * Open tabs are told to re-read it by a `work_claims_changed` frame whenever
 * a holder changes in this process; the panel also re-reads on a timer, which
 * covers a worker in a child process and a state that changes with time alone
 * (working → between messages → finished).
 */
import { basename } from "node:path";
import type { RouteHandler } from "../../server-context.js";
import { jsonResponse } from "../../server-utils.js";
import { holderNamesFrom, namedHolders, onSameErrand, sameBuild, setClaimsChangedListener, type HolderNames, type HolderView } from "../../agency/work-claims.js";
import { areasOf, reposOfSession } from "../../agency/other-agents-block.js";
import { normRepoPath, repoPathsOverlap } from "../../agency/path-overlap.js";
import { handleOwnCopyRoutes, ownCopyView } from "./own-copy.js";
import { handleOrchestratorRoutes, orchestratorView } from "./orchestrator.js";

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
  /** "files" when some file is claimed by both; "folder" when the overlap is
   *  only one side's folder holding the other's files. */
  clashScope?: "files" | "folder";
}

function overlaps(a: HolderView, b: HolderView): boolean {
  return a.claims.some((x) => b.claims.some((y) => repoPathsOverlap(normRepoPath(x.path), normRepoPath(y.path))));
}

function sharesAFile(a: HolderView, b: HolderView): boolean {
  return a.claims.some((x) => b.claims.some((y) => normRepoPath(x.path) === normRepoPath(y.path)));
}

function rowOf(h: HolderView, all: HolderView[]): WorkClaimRow {
  // A run that has ended (`recent`) is not changing anything any more, and
  // workers of one build are the build's to merge (work-claims.ts sameBuild).
  const clashing = h.state === "recent" ? [] : all.filter((o) => o !== h && o.repoKey === h.repoKey && o.state !== "recent"
    && !onSameErrand(h.sessionId, o.sessionId) && !sameBuild(h, o) && overlaps(h, o));
  return {
    sessionId: h.sessionId,
    opId: h.opId ?? null,
    kind: h.kind,
    displayName: h.displayName,
    // A holder named by its task's first line would say it twice.
    task: h.task.replace(/^[#>\s]+/, "").startsWith(h.displayName) ? "" : h.task,
    state: h.state,
    folder: basename(h.checkout),
    areas: areasOf(h),
    clashesWith: clashing.map((o) => o.displayName),
    ...(clashing.length ? { clashScope: clashing.some((o) => sharesAFile(h, o)) ? "files" as const : "folder" as const } : {}),
  };
}

export function workClaimRows(names?: HolderNames): WorkClaimRow[] {
  const all = namedHolders(names);
  return all.map((h) => rowOf(h, all));
}

/** A chat's own rows: the chat, and every agent working on its behalf. */
export function rowsOfChat(sessionId: string, rows: WorkClaimRow[]): WorkClaimRow[] {
  return rows.filter((r) => r.sessionId === sessionId || onSameErrand(r.sessionId, sessionId));
}

/** The other agents working in the repos `sessionId` works in, each flagged
 *  when its claims overlap that session's: the strip a chat window shows. */
export function othersInProjectOf(sessionId: string, names?: HolderNames): Array<WorkClaimRow & { clashesWithMe: boolean }> {
  const repos = new Set(reposOfSession(sessionId));
  const all = namedHolders(names);
  const here = all.filter((h) => repos.has(h.repoKey) && h.state !== "recent");
  const mine = here.filter((h) => h.sessionId === sessionId);
  return here
    .filter((h) => h.sessionId !== sessionId)
    .map((h) => ({ ...rowOf(h, all), clashesWithMe: !onSameErrand(h.sessionId, sessionId) && mine.some((m) => m.repoKey === h.repoKey && overlaps(h, m)) }));
}

export const handleWorkClaimRoutes: RouteHandler = async (method, url, req, res, ctx, role) => {
  if (await handleOwnCopyRoutes(method, url, req, res, ctx, role)) return true;
  if (await handleOrchestratorRoutes(method, url, req, res, ctx, role)) return true;
  if (method !== "GET" || url.pathname !== "/api/work-claims") return false;
  const session = url.searchParams.get("session");
  const sessions = ctx.sessionStore.list();
  const names = holderNamesFrom(sessions);
  const holders = workClaimRows(names).filter((row) => row.state !== "recent");
  const forChat = session
    ? { mine: rowsOfChat(session, holders), others: othersInProjectOf(session, names), ownCopy: ownCopyView(ctx, session, names), orchestrator: orchestratorView(ctx, session, sessions) }
    : {};
  jsonResponse(res, 200, { holders, ...forChat }, req);
  return true;
};

/** Tell open tabs when a holder changes. Called once at boot. */
export function wireWorkClaimsBroadcast(): void {
  setClaimsChangedListener(() => void import("../../chat-ws/index.js")
    .then(({ broadcastAll }) => broadcastAll({ type: "work_claims_changed" }))
    .catch(() => { /* no socket server (a child process, a test) */ }));
}
