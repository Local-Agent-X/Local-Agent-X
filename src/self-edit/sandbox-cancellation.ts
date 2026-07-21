import { acquireGlobalSelfEditLock } from "./global-lock.js";

export async function acquireSandboxLease(task: string, external?: AbortSignal) {
  const controller = new AbortController();
  const signal = external ? AbortSignal.any([external, controller.signal]) : controller.signal;
  let revocable = true;
  const lock = await acquireGlobalSelfEditLock({
    task,
    onRevoke: () => {
      if (!revocable) return false;
      controller.abort();
      return true;
    },
  });
  return { lock, signal, seal: () => { revocable = false; } };
}
