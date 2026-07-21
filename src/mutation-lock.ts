import {
  acquireMutationLock, mutationLockHeldByLiveProcess, releaseMutationLock,
  type MutationLockHolder, type MutationLockResult,
} from "../scripts/installer/transaction-lock.mjs";

export type SharedMutationHolder = MutationLockHolder;
export type SharedMutationLock = MutationLockResult;

export function acquireSharedMutationLock(
  dataDirectory: string,
  options: { task?: string; force?: boolean; onRevoke?: () => boolean | void } = {},
): Promise<SharedMutationLock> {
  return acquireMutationLock(dataDirectory, options);
}

export function releaseSharedMutationLock(lock?: SharedMutationLock): Promise<void> {
  return releaseMutationLock(lock);
}

export function sharedMutationLockHeld(dataDirectory: string): Promise<boolean> {
  return mutationLockHeldByLiveProcess(dataDirectory);
}
