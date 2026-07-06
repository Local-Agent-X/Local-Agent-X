// Agent redirect / control frames from the WS client — the per-id-shape
// routing that used to live inline in message-router.ts (split out to keep
// the router under the source-hygiene LOC ceiling; behavior unchanged).
import type { WebSocket } from "ws";

// Route by id prefix:
//   - op_*    → worker-pool op, use canonical opRedirect
//   - agent-* → legacy Handler.redirectAgent
// Pre-fix bug: handler used Handler unconditionally for both id shapes.
// op_* redirects silently no-opped because Handler doesn't track
// worker-pool ids — the user typed a redirect, hit Enter, saw nothing
// happen, and the worker kept doing the wrong thing.
export async function handleAgentRedirect(ws: WebSocket, agentId: string, instruction: string): Promise<void> {
  try {
    if (agentId.startsWith("op_")) {
      const { opRedirect } = await import("../canonical-loop/index.js");
      const res = opRedirect(agentId, instruction, "user");
      if (!res.ok) ws.send(JSON.stringify({ type: "error", message: `Op ${agentId} not running (cannot redirect)` }));
    } else {
      const { Handler } = await import("../agency/handler.js");
      const handler = Handler.getInstance();
      handler.redirectAgent(agentId, instruction);
    }
  } catch (e) {
    ws.send(JSON.stringify({ type: "error", message: `Redirect failed: ${(e as Error).message}` }));
  }
}

// Route by id prefix. Three id shapes coexist in the AGENTS sidebar:
//   - op_ap_*  → autopilot ops (separate lifecycle, only stop is supported)
//   - op_*     → canonical-loop ops (opCancel / opPause / opResume)
//   - agent-*  → legacy Handler sub-agents
export async function handleAgentControl(ws: WebSocket, agentId: string, action: string): Promise<void> {
  try {
    if (agentId.startsWith("op_ap_")) {
      const { requestStop } = await import("../autopilot/loop.js");
      try {
        const result = requestStop(agentId);
        if (!result) {
          ws.send(JSON.stringify({ type: "error", message: `Autopilot ${agentId} not active (already finished or unknown)` }));
        } else if (action === "pause" || action === "resume") {
          ws.send(JSON.stringify({ type: "error", message: `Autopilot doesn't support pause/resume — sent stop instead. Run will end after current round.` }));
        }
      } catch (e) {
        ws.send(JSON.stringify({ type: "error", message: `Autopilot stop failed: ${(e as Error).message}` }));
      }
    } else if (agentId.startsWith("op_")) {
      const { opCancel, opPause, opResume } = await import("../canonical-loop/index.js");
      switch (action) {
        case "cancel": {
          const res = opCancel(agentId, "user-stop");
          if (!res.ok) ws.send(JSON.stringify({ type: "error", message: `Op ${agentId} not found (already finished)` }));
          break;
        }
        case "pause": {
          const res = opPause(agentId, "user");
          if (!res.ok) ws.send(JSON.stringify({ type: "error", message: `pause failed: ${res.code}` }));
          break;
        }
        case "resume": {
          const res = opResume(agentId, "user");
          if (!res.ok) ws.send(JSON.stringify({ type: "error", message: `resume failed: ${res.code}` }));
          break;
        }
      }
    } else {
      const { Handler } = await import("../agency/handler.js");
      const handler = Handler.getInstance();
      switch (action) {
        case "pause":  handler.pauseAgent(agentId); break;
        case "resume": handler.resumeAgent(agentId); break;
        case "cancel": handler.cancelAgent(agentId); break;
        default:
          ws.send(JSON.stringify({ type: "error", message: `Unknown action: ${action}` }));
      }
    }
  } catch (e) {
    ws.send(JSON.stringify({ type: "error", message: `Agent control failed: ${e}` }));
  }
}
