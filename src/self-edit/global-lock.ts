import { getLaxDir } from "../lax-data-dir.js";
import {
  acquireSharedMutationLock, releaseSharedMutationLock, sharedMutationLockHeld,
  type SharedMutationHolder, type SharedMutationLock,
} from "../mutation-lock.js";

export type LockHolder = SharedMutationHolder;

export interface LockResult {
  acquired: boolean;
  holder?: LockHolder;
  nonce?: string;
}

export interface AcquireOptions {
  force?: boolean;
  task?: string;
  onRevoke?: () => boolean | void;
}

const heldLocks = new Map<string, SharedMutationLock>();

function normalizeTask(value: string): string {
  return value.toLowerCase().replace(/\s+/g, " ").trim().slice(0, 80);
}

export function formatGlobalLockBusy(holder: LockHolder | undefined, incomingTask: string): string {
  const ageMs = holder ? Date.now() - Date.parse(holder.startedAt) : NaN;
  const ageS = Number.isFinite(ageMs) ? Math.round(ageMs / 1000) : 0;
  const same = !!holder?.task && normalizeTask(holder.task) === normalizeTask(incomingTask);
  const what = same ? "the same change is already being applied" : "another installation, update, or self_edit is already mutating the installation";
  return (
    `A protected installation mutation is already running on this machine (started ${ageS}s ago) — ${what}. `
    + "The current operation keeps its lease until it finishes so overlapping changes cannot corrupt the installation. "
    + "END THIS TURN NOW — tell the user, in your own words, that the change is in flight and you'll surface the result when it lands. "
    + "Do NOT retry the mutation until the running operation finishes."
  );
}

export async function acquireGlobalSelfEditLock(opts: AcquireOptions = {}): Promise<LockResult> {
  const lock = await acquireSharedMutationLock(getLaxDir(), { ...opts, task: opts.task || "self_edit" });
  if (lock.acquired && lock.nonce) heldLocks.set(lock.nonce, lock);
  return { acquired: lock.acquired, holder: lock.holder, nonce: lock.nonce };
}

export function isSelfEditLockHeldByLiveProcess(): Promise<boolean> {
  return sharedMutationLockHeld(getLaxDir());
}

export async function releaseGlobalSelfEditLock(nonce?: string): Promise<void> {
  if (!nonce) return;
  const lock = heldLocks.get(nonce);
  heldLocks.delete(nonce);
  await releaseSharedMutationLock(lock);
}
