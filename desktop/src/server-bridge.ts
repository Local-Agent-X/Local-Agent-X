import { shell } from "electron";
import type { ChildProcess } from "child_process";

// Fulfills native-capability requests from the server child over the IPC
// channel using Electron main-only APIs. Currently: trashItem, so server-side
// deletes land in the OS Trash / Recycle Bin with Put Back (macOS) / Restore
// (Windows, Linux) — a raw filesystem move into ~/.Trash records neither.

interface TrashRequest { type: "lax:trash-item"; id: number; path: string; }

export function attachServerBridge(proc: ChildProcess): void {
  proc.on("message", async (msg: TrashRequest) => {
    if (!msg || msg.type !== "lax:trash-item") return;
    let ok = false;
    try { await shell.trashItem(msg.path); ok = true; } catch { ok = false; }
    try { proc.send?.({ type: "lax:trash-item-result", id: msg.id, ok }); } catch { /* child exited */ }
  });
}
