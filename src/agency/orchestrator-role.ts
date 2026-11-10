/**
 * The orchestrator of a project (ADR 0007 §7): one chat the user marks, per
 * repo, that delegates work to other agents and answers coordination
 * questions by written rules so the user is not asked each time.
 *
 * What it is here: a record of which chat holds the role in which repo, the
 * user's standing model preferences for the work it hands out, and the rules
 * the harness applies on its behalf. The chat's own agent learns the role from
 * its prompt (orchestrator-brief.ts) and delegates with `agent_spawn`.
 *
 * The rule applied here (`applyFolderRule`): two agents never write one
 * checkout. When a chat starts a turn in a folder another chat is writing, and
 * the project has an orchestrator, the later chat is moved to its own copy
 * (chat-own-copy.ts) before it writes, and a hand-over note says so. A chat
 * that already changed files in the shared folder cannot be moved; it keeps
 * being asked through the write check (tool-execution/claim-clash-gate.ts).
 *
 * What the role never covers: anything the app asks the user for safety (tool
 * approvals, control files, a secret's first use). Those have no path through
 * here at all.
 */
import { join } from "node:path";
import { getLaxDir } from "../lax-data-dir.js";
import { createJsonStore } from "../util/json-store.js";
import { locateInRepo } from "./repo-locate.js";
import { holdersOfSession, liveHolders } from "./work-claims.js";
import { ownCopyOf, startOwnCopy } from "./chat-own-copy.js";
import { postNote } from "./handover-notes.js";

export const ROUTING_MAX = 1_000;

export interface OrchestratorRole {
  sessionId: string;
  repoKey: string;
  since: string;
  /** The user's standing preferences for which model does what, in their words. */
  routing: string;
}

interface RoleFile extends Record<string, unknown> { byRepo: Record<string, OrchestratorRole> }

let fileOverride: string | null = null;
function store() {
  return createJsonStore<RoleFile>(fileOverride ?? join(getLaxDir(), "coordination", "orchestrators.json"), { defaults: () => ({ byRepo: {} }) });
}

/** The repo a project folder is in, or null when it is no git repo. */
export function repoKeyOfFolder(folder: string): string | null {
  const place = locateInRepo(join(folder, ".orchestrator"));
  return place && !place.repoKey.startsWith("dir:") ? place.repoKey : null;
}

export function orchestratorOf(repoKey: string): OrchestratorRole | null {
  return store().load().byRepo[repoKey] ?? null;
}

/** The repos `sessionId` is the orchestrator of. */
export function rolesOf(sessionId: string): OrchestratorRole[] {
  return Object.values(store().load().byRepo).filter((r) => r.sessionId === sessionId);
}

/** Make `sessionId` the orchestrator of the repo; replaces whoever was. */
export function takeOrchestratorRole(sessionId: string, repoKey: string, routing?: string): OrchestratorRole {
  const prior = orchestratorOf(repoKey);
  const role: OrchestratorRole = {
    sessionId, repoKey, since: new Date().toISOString(),
    routing: (routing ?? (prior?.sessionId === sessionId ? prior.routing : "")).trim().slice(0, ROUTING_MAX),
  };
  store().mutate((d) => { d.byRepo[repoKey] = role; });
  return role;
}

/** Give the role up; true when `sessionId` held it. */
export function releaseOrchestratorRole(sessionId: string, repoKey: string): boolean {
  return store().mutate((d) => {
    if (d.byRepo[repoKey]?.sessionId !== sessionId) return false;
    delete d.byRepo[repoKey];
    return true;
  });
}

function sameDir(a: string, b: string): boolean {
  const n = (p: string) => p.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
  return n(a) === n(b);
}

/**
 * The orchestrator's rule for a shared folder, applied as `sessionId` starts a
 * turn in `projectFolder`. Returns what it did, for the log; null when the
 * rule does not apply (no orchestrator, the chat is the orchestrator, it
 * already has a copy, nobody else writes the folder, or it cannot be moved).
 */
export function applyFolderRule(sessionId: string, projectFolder: string, displayName?: string): string | null {
  const place = locateInRepo(join(projectFolder, ".orchestrator"));
  if (!place || place.repoKey.startsWith("dir:")) return null;
  const role = orchestratorOf(place.repoKey);
  if (!role || role.sessionId === sessionId || ownCopyOf(sessionId)) return null;
  const others = liveHolders(place.repoKey).filter((h) =>
    h.sessionId !== sessionId && h.kind === "chat" && h.state !== "recent" && sameDir(h.checkout, place.checkout)
    && h.claims.some((c) => c.source === "written"));
  if (others.length === 0) return null;
  const started = startOwnCopy(sessionId, projectFolder);
  if (!started.ok) return null;
  const who = displayName ?? holdersOfSession(sessionId)[0]?.displayName ?? "A chat";
  const text = `${who} now works in its own copy (branch ${started.copy.branch}): ${others.map((o) => o.displayName).join(", ")} is writing this folder, and two agents never write one folder. It merges back when the user says so.`;
  try {
    postNote({ sessionId: role.sessionId, displayName: "Orchestrator", repoKey: place.repoKey, paths: [], text, kind: "agent" });
  } catch { /* the move stands; a note that could not be posted changes nothing */ }
  return text;
}

/** Test seam. */
export function _setOrchestratorFileForTest(file: string | null): void {
  fileOverride = file;
}
