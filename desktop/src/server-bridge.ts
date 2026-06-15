import { shell } from "electron";
import type { ChildProcess } from "child_process";

// Fulfills native-capability requests from the server child over the IPC
// channel using Electron main-only APIs:
//   - trashItem: server-side deletes land in the OS Trash / Recycle Bin with
//     Put Back (macOS) / Restore (Windows, Linux) — a raw move into ~/.Trash
//     records neither.
//   - restart-server / relaunch-app: lets the agent self-restart over messaging
//     (the `restart` / `apply_update` tools). The actions are injected as
//     handlers so this module doesn't import server-process (which imports us).

interface TrashRequest { type: "lax:trash-item"; id: number; path: string; }
interface RestartRequest { type: "lax:restart-server" }
interface RelaunchRequest { type: "lax:relaunch-app" }
type ServerMessage = TrashRequest | RestartRequest | RelaunchRequest;

export interface ServerBridgeHandlers {
  /** Restart the server child (picks up new src/dist). */
  onRestartServer: () => void;
  /** Relaunch the whole Electron app (picks up desktop/ changes too). */
  onRelaunchApp: () => void;
}

export function attachServerBridge(proc: ChildProcess, handlers: ServerBridgeHandlers): void {
  proc.on("message", async (msg: ServerMessage) => {
    if (!msg || typeof msg.type !== "string") return;
    if (msg.type === "lax:trash-item") {
      let ok = false;
      try { await shell.trashItem(msg.path); ok = true; } catch { ok = false; }
      try { proc.send?.({ type: "lax:trash-item-result", id: msg.id, ok }); } catch { /* child exited */ }
      return;
    }
    if (msg.type === "lax:restart-server") {
      console.log("[desktop] server child requested a restart");
      try { handlers.onRestartServer(); } catch (e) { console.error("[desktop] restart handler failed", e); }
      return;
    }
    if (msg.type === "lax:relaunch-app") {
      console.log("[desktop] server child requested a full app relaunch");
      try { handlers.onRelaunchApp(); } catch (e) { console.error("[desktop] relaunch handler failed", e); }
      return;
    }
  });
}
