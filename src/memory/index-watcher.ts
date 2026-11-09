import { watch } from "node:fs";
import { handleWatcherErrors } from "../util/watcher-errors.js";

export interface WatcherHandle {
  watcher: ReturnType<typeof watch> | null;
  debounceTimer: ReturnType<typeof setTimeout> | null;
}

export function startWatcher(
  memoryDir: string,
  setDirty: () => void,
  handle: WatcherHandle
): void {
  try {
    handle.watcher = handleWatcherErrors(watch(memoryDir, { recursive: true }, (_event, filename) => {
      if (
        filename &&
        (filename.includes(".git") ||
          filename.includes("node_modules") ||
          filename.startsWith("."))
      ) {
        return;
      }

      if (handle.debounceTimer) clearTimeout(handle.debounceTimer);
      handle.debounceTimer = setTimeout(() => {
        setDirty();
        handle.debounceTimer = null;
      }, 500);
    }), "memory-index");
  } catch {
  }
}
