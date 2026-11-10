// camera_watch: the agent's handle on a call's camera watch (voice-session/camera-watch.ts).
// "Tell me when the water boils" starts one; the watch then speaks up on the call by
// itself when it sees it, so the agent's reply only confirms it is watching.

import type { ToolDefinition, ToolResult } from "../types.js";
import { sessionIdOf } from "../tool-execution/internal-args.js";
import { cameraWatchFor, WATCH_DEFAULT_MINUTES, WATCH_MAX_MINUTES } from "./voice-session/camera-watch.js";

const NO_CALL = "There is no voice call with the camera on in this chat. Watching works on a call from the phone with its camera open.";

export function createCameraWatchTool(deps: { whyCannotSee?: () => Promise<string | null> } = {}): ToolDefinition {
  const whyCannotSee = deps.whyCannotSee
    ?? (async () => (await import("./voice-session/camera-watch-check.js")).whyWatchCannotSee());
  return {
    name: "camera_watch",
    description:
      "Watch the call's camera and speak up when something happens. Use it when the user asks to be told " +
      "when something they are pointing the camera at happens (\"tell me when the water boils\", \"let me know " +
      "when the cat comes back\"). action=start begins watching for `condition` and returns at once; you will " +
      "say it out loud by yourself when you see it, so just confirm you're watching. The watch stops when it " +
      "sees it, when the camera closes, or after `minutes`. action=stop cancels it; action=status says what is " +
      "being watched or how the last watch ended.",
    parameters: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["start", "stop", "status"], description: "start, stop or status." },
        condition: {
          type: "string",
          description: "For start: what to watch for, as something you could see in one picture (\"the water in the pot is boiling\").",
        },
        minutes: {
          type: "number",
          description: `For start: how long to keep watching (default ${WATCH_DEFAULT_MINUTES}, at most ${WATCH_MAX_MINUTES}).`,
        },
      },
      required: ["action"],
    },
    async execute(args: Record<string, unknown>): Promise<ToolResult> {
      const watch = cameraWatchFor(sessionIdOf(args) ?? "");
      const action = String(args.action ?? "");
      if (action === "status") return { content: watch ? watch.status() : NO_CALL };
      if (action === "stop") {
        const was = watch?.cancel() ?? null;
        return { content: was ? `Stopped watching for ${was}.` : "Nothing was being watched." };
      }
      if (action !== "start") return { content: `Unknown action "${action}": use start, stop or status.`, isError: true };
      if (!watch) return { content: NO_CALL, isError: true };
      const cannot = await whyCannotSee();
      if (cannot) return { content: cannot, isError: true };
      const minutes = typeof args.minutes === "number" ? args.minutes : undefined;
      const started = watch.start(String(args.condition ?? ""), minutes);
      if (!started.ok) return { content: started.reason, isError: true };
      const replaced = started.replaced ? ` (this replaces the watch for ${started.replaced})` : "";
      return {
        content: `Watching the camera for ${String(args.condition).trim()} for up to ${started.minutes} minutes${replaced}. ` +
          "You'll say it on the call by yourself when you see it; now just tell the user you're watching.",
      };
    },
  };
}
