import { createServer as createNetServer } from "node:net";

export const LIFECYCLE_BARRIERS = [
  "proxy-bind",
  "free-port",
  "write",
  "spawn",
  "health",
  "stop",
  "restart",
] as const;

export type LifecycleBarrierName = (typeof LIFECYCLE_BARRIERS)[number];

export interface QualificationLifecycleOptions {
  barriers?: Partial<Record<LifecycleBarrierName, (signal: AbortSignal) => Promise<void>>>;
  onChildSpawn?(pid: number): void;
}

export function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw signal.reason instanceof Error ? signal.reason : new Error("qualification operation aborted");
}

export async function waitForBarrier(
  options: QualificationLifecycleOptions,
  name: LifecycleBarrierName,
  signal: AbortSignal,
): Promise<void> {
  throwIfAborted(signal);
  await options.barriers?.[name]?.(signal);
  throwIfAborted(signal);
}

export function delayWithSignal(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(finish, ms);
    timer.unref?.();
    const abort = () => finish(signal.reason instanceof Error ? signal.reason : new Error("qualification operation aborted"));
    function finish(error?: Error): void {
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
      if (error) reject(error);
      else resolve();
    }
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
  });
}

export async function freePort(signal: AbortSignal): Promise<number> {
  throwIfAborted(signal);
  return await new Promise<number>((resolve, reject) => {
    const server = createNetServer();
    const abort = () => server.close(() => reject(signal.reason));
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      if (signal.aborted) return abort();
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close((error) => error ? reject(error) : resolve(port));
    });
    signal.addEventListener("abort", abort, { once: true });
    server.once("close", () => signal.removeEventListener("abort", abort));
  });
}

export function requestSignal(signal: AbortSignal, timeoutMs: number): AbortSignal {
  return AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]);
}
