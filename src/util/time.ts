/** Units of time and a timer, so modules stop declaring their own. */

/** One day in milliseconds. */
export const MS_PER_DAY = 86_400_000;

/** Resolve after `ms` milliseconds. */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Let everything waiting on the event loop run before going on. A long
 *  synchronous job calls this between its steps so the server keeps answering. */
export function yieldEventLoop(): Promise<void> {
  return new Promise<void>((resolve) => setImmediate(resolve));
}
