// The temp roots a test file could not delete when it finished, deleted at the end of
// the run instead.
//
// Each test file gets its own temp HOME and workspace (test-env.ts) and deletes them in
// its afterAll. On Windows a file an antivirus scanner or the indexer still holds is
// only marked "delete pending", so its folder stays non-empty until the scanner lets
// go, and on a loaded CI runner that outlasted the cleanup's retries: two Windows runs
// on main went red on ENOTEMPTY for that reason alone, every test in them passing
// (2026-11-18 email-repeat-check, 2026-11-20 spec-audit). Such a folder is handed to
// the end-of-run sweep, which runs once every test file is done and the scanner has
// had minutes, and which still fails the run if the folder will not go.
//
// Deletes use the promise `rm`: on Node 24 `rmSync` ignores maxRetries and throws on
// the first EPERM (measured 2026-11-20: 2 ms, where the promise `rm` waited out a 3 s
// lock), so a sync cleanup never retried at all on a developer's Windows box.
//
// Only Windows' lock errors are handed over. Anywhere else, or with no sweep wired
// (LEFTOVERS_ENV unset), a failed delete throws as before: there it means something
// is still writing into the folder.

import { appendFileSync, existsSync, mkdtempSync, readFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** The file test files append their undeletable roots to, one per line. */
export const LEFTOVERS_ENV = "LAX_TEST_LEFTOVER_ROOTS";

/** Windows' lock errors, plus our own deadline (below) running out while they repeat. */
const WINDOWS_LOCK_CODES = new Set(["ENOTEMPTY", "EBUSY", "EPERM", "ETIMEDOUT"]);

/** rm backs off linearly, retryDelay more per try, and retries each entry in the tree
 *  on its own, so a held tree can outlast vitest's 10 s hook and teardown timeouts.
 *  A wall-clock deadline caps each delete below them: a test file deletes its roots
 *  side by side within 5 s, and the sweep deletes all its roots side by side within 8 s. */
const FILE_RETRY = { maxRetries: process.platform === "win32" ? 8 : 5, retryDelay: 100 };
const SWEEP_RETRY = { maxRetries: 10, retryDelay: 200 };
const FILE_DEADLINE_MS = 5_000;
const SWEEP_DEADLINE_MS = 8_000;

/** Delete a tree, failing with ETIMEDOUT if the retries are still going at the deadline
 *  (the delete keeps going in the background; `force` makes a later one a no-op). */
function removeWithin(dir: string, retry: { maxRetries: number; retryDelay: number }, deadlineMs: number): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      reject(Object.assign(new Error(`still held after ${deadlineMs} ms`), { code: "ETIMEDOUT" }));
    }, deadlineMs);
  });
  return Promise.race([rm(dir, { recursive: true, force: true, ...retry }), deadline]).finally(() => clearTimeout(timer));
}

export interface RemoveDeps {
  platform: NodeJS.Platform;
  leftoversFile: string | undefined;
  remove: (dir: string) => Promise<void>;
  record: (file: string, dir: string) => void;
}

const realRemoveDeps = (): RemoveDeps => ({
  platform: process.platform,
  leftoversFile: process.env[LEFTOVERS_ENV],
  remove: (dir) => removeWithin(dir, FILE_RETRY, FILE_DEADLINE_MS),
  record: (file, dir) => {
    appendFileSync(file, `${dir}\n`, "utf-8");
    console.warn(`[test-env] Windows still holds ${dir}; the end-of-run sweep deletes it`);
  },
});

/** Delete a test file's temp root, or hand a root Windows still holds to the sweep. */
export async function removeTestRoot(dir: string, deps: RemoveDeps = realRemoveDeps()): Promise<void> {
  try {
    await deps.remove(dir);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code ?? "";
    if (deps.platform !== "win32" || !WINDOWS_LOCK_CODES.has(code) || !deps.leftoversFile) throw error;
    deps.record(deps.leftoversFile, dir);
  }
}

/** Delete every handed-over root; throws naming each one that still will not go. */
export async function sweepLeftoverRoots(
  leftoversFile: string,
  remove: (dir: string) => Promise<void> = (dir) => removeWithin(dir, SWEEP_RETRY, SWEEP_DEADLINE_MS),
): Promise<void> {
  if (!existsSync(leftoversFile)) return;
  const dirs = [...new Set(readFileSync(leftoversFile, "utf-8").split(/\r?\n/).filter(Boolean))];
  const results = await Promise.allSettled(dirs.map((dir) => remove(dir)));
  const stuck = results.flatMap((result, i) => {
    if (result.status === "fulfilled") return [];
    const error = result.reason as NodeJS.ErrnoException;
    return [`${dirs[i]} (${error.code ?? error.message})`];
  });
  if (stuck.length > 0) {
    throw new Error(`test temp roots still could not be deleted at the end of the run:\n${stuck.join("\n")}`);
  }
}

/** vitest globalSetup: give the run a leftovers file, and sweep it when the run ends.
 *  A root that will not go fails the run through the exit code: vitest prints an error
 *  thrown from a globalSetup teardown ("error during close") and still exits 0. */
export default function setup(): () => Promise<void> {
  const runDir = mkdtempSync(join(tmpdir(), "lax-test-run-"));
  const leftoversFile = join(runDir, "leftover-roots.txt");
  process.env[LEFTOVERS_ENV] = leftoversFile;
  return async () => {
    try {
      await sweepLeftoverRoots(leftoversFile);
    } catch (error) {
      console.error((error as Error).message);
      process.exitCode = 1;
    } finally {
      await rm(runDir, { recursive: true, force: true });
    }
  };
}
