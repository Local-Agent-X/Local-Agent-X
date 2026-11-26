/**
 * Delete a directory tree, trying again while Windows still holds a file in it.
 * A process just killed keeps its handles for a moment (a probe server, a
 * build's Gradle daemon, an editor on node_modules), and a delete that fails
 * once was never tried again: worktree copies piled up in Temp, 2.4 GB of them
 * by 2026-11-25. Never throws; returns whether the tree is gone, and says why
 * through `onGiveUp` when it is not.
 */
import { rm } from "node:fs/promises";

export async function removeTreeRetrying(
  path: string,
  onGiveUp: (reason: string) => void,
  attempts = 6,
  waitMs = 600,
): Promise<boolean> {
  for (let attempt = 1; ; attempt++) {
    try {
      await rm(path, { recursive: true, force: true });
      return true;
    } catch (e) {
      if (attempt >= attempts) {
        onGiveUp((e as Error).message);
        return false;
      }
      await new Promise((resolve) => setTimeout(resolve, waitMs));
    }
  }
}
