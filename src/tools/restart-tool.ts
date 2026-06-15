import type { ToolDefinition, ToolResult } from "../types.js";
import { desktopBridgeAvailable, desktopRestartServer } from "../desktop-bridge.js";
import { writeRestartNotice, resolveNotifyTarget } from "../restart-notify.js";
import { recentlyDone, markDone } from "./idempotency.js";

const RESTART_COOLDOWN_MS = 60_000;
// Let the "restarting now" reply flush + deliver over the bridge before the kill.
const RESTART_DELAY_MS = 4_000;

export const restart: ToolDefinition = {
  name: "restart",
  description:
    "Restart the LAX server to pick up new code (after a self_edit, a git pull, " +
    "or a config change that needs a reload). The server goes down briefly and " +
    "the agent messages you when it's back up. Only works in the desktop app. " +
    "Use when the user asks to restart / reload / 'pick up new code'. For a " +
    "platform UPDATE use apply_update instead (it restarts for you).",
  parameters: {
    type: "object",
    properties: { reason: { type: "string", description: "Short reason shown in the back-up ping, e.g. 'pick up new code'." } },
    required: [],
  },
  async execute(args: Record<string, unknown>): Promise<ToolResult> {
    if (!desktopBridgeAvailable()) {
      return { content: "Can't self-restart: not running under the desktop app (no relaunch supervisor). Restart manually, or run with npm run dev:supervised.", isError: true };
    }
    // Cooldown so an injected "restart yourself" can't loop the app.
    if (recentlyDone("restart", "global", RESTART_COOLDOWN_MS)) {
      return { content: "A restart was just triggered moments ago — skipping to avoid a restart loop. Try again in a minute if it's really needed.", isError: true };
    }
    const target = await resolveNotifyTarget(args);
    if (!target) {
      return { content: "I can restart, but no messaging channel is connected to ping you back. Connect Telegram or WhatsApp first (or restart from the app).", isError: true };
    }
    const reason = String(args.reason || "pick up new code").slice(0, 120);
    const now = Date.now();
    writeRestartNotice({ channel: target.channel, target: target.target, reason, requestedAt: now, deadlineMs: now + 120_000 });
    markDone("restart", "global", "triggered");
    setTimeout(() => { desktopRestartServer(); }, RESTART_DELAY_MS);
    return { content: `Restarting the server now to ${reason}. I'll message you on ${target.channel} when it's back up (usually ~10–30s).` };
  },
};

export const restartTools: ToolDefinition[] = [restart];
