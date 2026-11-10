/**
 * What each agent working in parallel is changing (ADR 0007 §1): one holder
 * per (session, repo), each holding claims on repo-relative paths.
 *
 * A **holder** is a chat or a worker (sub-agent, fan-out worker, auto-build
 * chunk, autopilot round, self-edit), keyed by the session its tool calls run
 * in. Claims are **written** (every file a successful write touched, recorded
 * by the tool pipeline, claim-clash-gate.ts) or **declared** (`work_note` with
 * `claim: true`, or a spawn's declared area).
 *
 * **Liveness rides the op lease**, never a second heartbeat: a holder whose op
 * is running with a fresh lease is `active`. Past that, a chat stays `idle`
 * (still on its task between messages) for CHAT_IDLE_HOLD_MS after its last
 * activity, any holder is `recent` for RECENT_MS, and then it is gone (its
 * file is swept on the next read).
 *
 * **Storage:** one JSON file per holder under `<lax dir>/coordination/holders/`,
 * written only by the process running that holder, so parallel workers in
 * child processes never race on a shared file. Readers list the folder,
 * cached for a second per process.
 */
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { getLaxDir } from "../lax-data-dir.js";
import { atomicWriteFileSync, ensureDirFor } from "../util/json-store.js";
import { readOp } from "../ops/op-store.js";
import type { Op } from "../ops/types.js";
import { isLeaseExpired } from "../canonical-loop/public/op-facts.js";
import { locateInRepo } from "./repo-locate.js";
import { normRepoPath, repoPathsOverlap } from "./path-overlap.js";

export const CHAT_IDLE_HOLD_MS = 30 * 60_000;
export const RECENT_MS = 2 * 60 * 60_000;
export const WORKER_START_GRACE_MS = 5 * 60_000;
const MAX_CLAIMS = 200;
const READ_CACHE_MS = 1_000;

export interface Claim {
  /** Repo-relative, `/`-separated, as the agent named it. */
  path: string;
  source: "declared" | "written";
  since: string;
}

export interface WorkHolder {
  v: 1;
  sessionId: string;
  repoKey: string;
  /** The checkout this holder writes: a worktree or the main folder. */
  checkout: string;
  kind: "chat" | "worker";
  displayName: string;
  /** One line: what it is doing. */
  task: string;
  opId?: string;
  parentOpId?: string;
  claims: Claim[];
  lastActiveAt: string;
}

export type HolderState = "active" | "idle" | "recent" | "gone";

export interface HolderView extends WorkHolder { state: HolderState }

let dirOverride: string | null = null;
let now: () => number = Date.now;
// Looked up at call time: a module that mocks the op store need not name readOp.
let opReader: ((opId: string) => Op | null) | null = null;
const readOpFor = (opId: string): Op | null => (opReader ?? readOp)(opId);

function holdersDir(): string {
  return dirOverride ?? join(getLaxDir(), "coordination", "holders");
}

function fileOf(sessionId: string, repoKey: string): string {
  const id = createHash("sha256").update(`${sessionId}\0${repoKey}`).digest("hex").slice(0, 32);
  return join(holdersDir(), `${id}.json`);
}

let cache: { at: number; holders: WorkHolder[] } | null = null;

function readAll(): WorkHolder[] {
  if (cache && now() - cache.at < READ_CACHE_MS) return cache.holders;
  const dir = holdersDir();
  const holders: WorkHolder[] = [];
  let names: string[] = [];
  try { names = readdirSync(dir).filter((n) => n.endsWith(".json")); } catch { /* no holders yet */ }
  for (const name of names) {
    try {
      const h = JSON.parse(readFileSync(join(dir, name), "utf8")) as WorkHolder;
      if (h && h.v === 1 && typeof h.sessionId === "string" && Array.isArray(h.claims)) holders.push(h);
    } catch { /* a file mid-write by another process, or torn: skip this read */ }
  }
  cache = { at: now(), holders };
  return holders;
}

function write(h: WorkHolder): void {
  const file = fileOf(h.sessionId, h.repoKey);
  ensureDirFor(file);
  atomicWriteFileSync(file, JSON.stringify(h));
  cache = null;
  notifyClaimsChanged();
}

/** Whether a holder is working now, between messages, lately, or gone. */
export function holderState(h: WorkHolder): HolderState {
  const op = h.opId ? readOpFor(h.opId) : null;
  const working = op && ["pending", "running", "paused", "needs-input"].includes(op.status) && !isLeaseExpired(op);
  if (working) return "active";
  const age = now() - Date.parse(h.lastActiveAt);
  // A worker that declared its area at spawn has no op on record until its
  // first tool call: it is starting, not gone.
  if (h.kind === "worker" && !h.opId && age <= WORKER_START_GRACE_MS) return "active";
  if (h.kind === "chat" && age <= CHAT_IDLE_HOLD_MS) return "idle";
  return age <= RECENT_MS ? "recent" : "gone";
}

/** Every holder that is not gone, with its state; sweeps the gone ones. */
export function liveHolders(repoKey?: string): HolderView[] {
  const out: HolderView[] = [];
  for (const h of readAll()) {
    if (repoKey && h.repoKey !== repoKey) continue;
    const state = holderState(h);
    if (state === "gone") {
      try { rmSync(fileOf(h.sessionId, h.repoKey), { force: true }); cache = null; } catch { /* another reader swept it */ }
      continue;
    }
    out.push({ ...h, state });
  }
  return out;
}

function describeFromOp(opId: string | undefined): Pick<WorkHolder, "kind" | "task" | "parentOpId"> {
  const op = opId ? readOpFor(opId) : null;
  const task = (op?.task ?? "").replace(/\s+/g, " ").trim().slice(0, 160);
  return { kind: op && op.lane !== "interactive" ? "worker" : "chat", task, ...(op?.parentOpId ? { parentOpId: op.parentOpId } : {}) };
}

export interface ClaimInput {
  sessionId: string;
  opId?: string;
  /** Absolute paths. */
  paths: string[];
  source: Claim["source"];
  /** The session's project folder, for files in no git repo. */
  fallbackRoot?: string;
  displayName?: string;
  /** For a claim made before the holder's op exists (a spawn's declared area). */
  kind?: WorkHolder["kind"];
}

/** Record claims on `paths`, one holder per repo they fall in. */
export function recordClaims(input: ClaimInput): void {
  const byRepo = new Map<string, { checkout: string; rels: string[] }>();
  for (const p of input.paths) {
    const place = locateInRepo(p, input.fallbackRoot);
    if (!place) continue;
    const entry = byRepo.get(place.repoKey) ?? { checkout: place.checkout, rels: [] };
    entry.rels.push(place.rel);
    byRepo.set(place.repoKey, entry);
  }
  if (byRepo.size === 0) return;
  const stamp = new Date(now()).toISOString();
  const described = describeFromOp(input.opId);
  for (const [repoKey, { checkout, rels }] of byRepo) {
    const prior = readAll().find((h) => h.sessionId === input.sessionId && h.repoKey === repoKey);
    const claims = mergeClaims(prior?.claims ?? [], rels, input.source, stamp);
    write({
      v: 1, sessionId: input.sessionId, repoKey, checkout,
      kind: input.opId ? described.kind : input.kind ?? prior?.kind ?? described.kind,
      displayName: input.displayName ?? prior?.displayName ?? (described.task.slice(0, 60) || input.sessionId),
      task: described.task || prior?.task || "",
      ...(input.opId ? { opId: input.opId } : prior?.opId ? { opId: prior.opId } : {}),
      ...(described.parentOpId ? { parentOpId: described.parentOpId } : {}),
      claims, lastActiveAt: stamp,
    });
  }
}

function mergeClaims(prior: Claim[], rels: string[], source: Claim["source"], stamp: string): Claim[] {
  const out = [...prior];
  for (const rel of rels) {
    const key = normRepoPath(rel);
    const at = out.findIndex((c) => normRepoPath(c.path) === key);
    // A written claim on a path declared earlier keeps its earlier `since`.
    if (at >= 0) { if (source === "written") out[at] = { ...out[at], source }; continue; }
    out.push({ path: rel, source, since: stamp });
  }
  return out.slice(-MAX_CLAIMS);
}

/** A turn of `sessionId` started on `opId`: its holders are current again. */
export function touchHolders(sessionId: string, opId: string, displayName?: string): void {
  const stamp = new Date(now()).toISOString();
  const described = describeFromOp(opId);
  for (const h of readAll()) {
    if (h.sessionId !== sessionId) continue;
    write({ ...h, opId, lastActiveAt: stamp, ...(described.task ? { task: described.task } : {}), ...(displayName ? { displayName } : {}) });
  }
}

const sessionOps = new Map<string, string>();

/** A tool call of `sessionId` ran under `opId`: attach it to the session's
 *  holders if they do not carry it yet (a claim declared at spawn has none). */
export function noteSessionOp(sessionId: string, opId: string | undefined): void {
  if (!opId || sessionOps.get(sessionId) === opId) return;
  if (sessionOps.size >= 2_000) sessionOps.clear();
  sessionOps.set(sessionId, opId);
  if (holdersOfSession(sessionId).some((h) => h.opId !== opId)) touchHolders(sessionId, opId);
}

export interface Clash {
  /** The repo-relative path this call writes. */
  path: string;
  other: HolderView;
  /** The other holder's claim it overlaps. */
  claim: Claim;
  /** Both write the same checkout: the clash is now, not at merge. */
  sameCheckout: boolean;
}

/** Other live holders whose claims overlap the files `sessionId` is about to write. */
export function findClashes(sessionId: string, absPaths: string[], fallbackRoot?: string): Clash[] {
  const out: Clash[] = [];
  for (const p of absPaths) {
    const place = locateInRepo(p, fallbackRoot);
    if (!place) continue;
    const target = normRepoPath(place.rel);
    for (const other of liveHolders(place.repoKey)) {
      if (other.sessionId === sessionId) continue;
      const claim = other.claims.find((c) => repoPathsOverlap(normRepoPath(c.path), target));
      if (!claim) continue;
      out.push({ path: place.rel, other, claim, sameCheckout: sameDir(other.checkout, place.checkout) });
    }
  }
  return out;
}

function sameDir(a: string, b: string): boolean {
  const n = (p: string) => p.replace(/\\/g, "/").replace(/\/+$/, "");
  return process.platform === "linux" ? n(a) === n(b) : n(a).toLowerCase() === n(b).toLowerCase();
}

/** The repos `sessionId` holds claims in. */
export function holdersOfSession(sessionId: string): WorkHolder[] {
  return readAll().filter((h) => h.sessionId === sessionId);
}

// ── change notification ──

let notifyTimer: ReturnType<typeof setTimeout> | null = null;
let onChanged: (() => void) | null = null;

/** Called (debounced) after any holder changes in this process. */
export function setClaimsChangedListener(fn: (() => void) | null): void {
  onChanged = fn;
}

function notifyClaimsChanged(): void {
  if (!onChanged || notifyTimer) return;
  notifyTimer = setTimeout(() => { notifyTimer = null; try { onChanged?.(); } catch { /* a listener never breaks a write */ } }, 250);
  notifyTimer.unref?.();
}

/** Test seams: the folder, the clock and the op reader. */
export function _setWorkClaimsForTest(opts: { dir?: string | null; clock?: () => number; readOp?: (id: string) => Op | null }): void {
  if (opts.dir !== undefined) dirOverride = opts.dir;
  if (opts.clock) now = opts.clock;
  if (opts.readOp) opReader = opts.readOp;
  cache = null;
}

export function _resetWorkClaimsForTest(): void {
  dirOverride = null; now = Date.now; opReader = null; cache = null; sessionOps.clear();
  if (notifyTimer) clearTimeout(notifyTimer);
  notifyTimer = null; onChanged = null;
}

