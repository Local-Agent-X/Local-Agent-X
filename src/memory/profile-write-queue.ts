/**
 * One profile write at a time per memory directory. Every profile writer
 * (memory_set_user_field, memory_update_profile, the end-of-turn pass,
 * auto-extract) reads a profile file, awaits an LLM-backed dedupe or
 * compaction, then overwrites the file with what it read plus its change. Two
 * of them in flight at once (the end-of-turn pass and auto-extract both run
 * after a turn) let the later overwrite erase the earlier one's change. Each
 * read-modify-write runs inside withProfileWrite, so the next one reads what
 * the previous one wrote.
 */
const tails = new Map<string, Promise<unknown>>();

export function withProfileWrite<T>(memoryDir: string, write: () => Promise<T>): Promise<T> {
  const previous = tails.get(memoryDir) ?? Promise.resolve();
  const run = previous.then(write, write);
  const tail = run.then(() => undefined, () => undefined);
  tails.set(memoryDir, tail);
  void tail.then(() => { if (tails.get(memoryDir) === tail) tails.delete(memoryDir); });
  return run;
}
