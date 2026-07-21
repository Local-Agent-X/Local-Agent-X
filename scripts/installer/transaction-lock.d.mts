export interface MutationLockHolder {
  version: 2;
  pid: number;
  ticket: string;
  incarnation: string;
  task?: string;
  startedAt: string;
}

export interface MutationLockResult {
  acquired: boolean;
  nonce?: string;
  ticket?: string;
  holder?: MutationLockHolder;
  path: string;
  identity?: { path: string; real: string | null; dev?: number; ino?: number; birthtimeMs?: number; missing?: boolean };
  unsafeState?: boolean;
}

export function acquireMutationLock(dataDirectory: string, options?: {
  task?: string;
  force?: boolean;
  onRevoke?: () => boolean | void;
  revokeTimeoutMs?: number;
  resolveIncarnation?: (pid: number) => string | null;
  resolveLegacyProcessIdentity?: (pid: number) => { startedAtMs: number; executable: string } | null;
}): Promise<MutationLockResult>;
export function releaseMutationLock(lock?: MutationLockResult): Promise<void>;
export function mutationLockHeldByLiveProcess(dataDirectory: string): Promise<boolean>;
export function mutationLockPath(dataDirectory: string): string;
export function mutationLockEndpoint(dataDirectory: string): {
  listen: { path: string } | { host: string; port: number };
  rootHash: string;
  listens?: Array<{ host: string; port: number }>;
};
export function resolveWindowsProcessIncarnation(
  pid: number,
  runner?: (...args: unknown[]) => { status: number | null; stdout: string },
  systemRoot?: string,
): string | null;
