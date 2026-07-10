import type { ToolDefinition, ToolResult } from "../types.js";
import { getTelegramBridgeInstance } from "../telegram-bridge/index.js";
import { formatForChannel } from "../channel-formatter.js";
import { recentlyDone, markDone, fingerprintOf, describeAge } from "./idempotency.js";

// A scheduled job that retries shouldn't double-ping the user with the same text.
const TELEGRAM_SEND_WINDOW_MS = 60_000;

export const telegramSend: ToolDefinition = {
  name: "telegram_send",
  effect: { class: "non-idempotent" },
  description:
    "Proactively send a Telegram message to the owner — a scheduled reminder, " +
    "check-in, accountability nudge, or alert. Use this to message the user on " +
    "Telegram OUTSIDE of replying to one of their messages (replies happen " +
    "automatically). Typical use: from a scheduled mission/cron. Sends to the " +
    "bridge's configured owner chat by default; only pass chat_id to target a " +
    "specific already-authorized chat. Requires the Telegram bridge to be set up " +
    "and connected (Settings → Telegram).",
  parameters: {
    type: "object",
    properties: {
      text: { type: "string", description: "Message text to send. Markdown supported." },
      chat_id: {
        type: "string",
        description:
          "Optional. A specific authorized chat ID to send to. Defaults to the owner's configured chat(s).",
      },
    },
    required: ["text"],
  },
  async execute(args: Record<string, unknown>): Promise<ToolResult> {
    const text = String(args.text ?? "").trim();
    if (!text) return { content: "telegram_send: 'text' is required and cannot be empty.", isError: true };

    const bridge = getTelegramBridgeInstance();
    if (!bridge) {
      return {
        content:
          "Telegram is not set up. Add a bot token (Settings → Telegram) and connect the bridge first.",
        isError: true,
      };
    }

    const status = bridge.getStatus();
    if (status.state !== "connected") {
      return {
        content:
          `Telegram bridge is not connected (state: ${status.state}` +
          `${status.error ? `: ${status.error}` : ""}). Connect it in Settings → Telegram.`,
        isError: true,
      };
    }

    const allowed = status.allowedChatIds;
    if (allowed.length === 0) {
      return {
        content:
          "No authorized Telegram chat is configured. Set your owner chat ID in " +
          "Settings → Telegram before the agent can message you.",
        isError: true,
      };
    }

    // Confine sends to authorized chats only. A prompt-injected instruction must
    // not be able to make the agent DM an arbitrary attacker-controlled chat —
    // the egress kernel gate is the outer wall; this is the inner allowlist.
    let targets: string[];
    const requested = args.chat_id != null ? String(args.chat_id).trim() : "";
    if (requested) {
      if (!allowed.includes(requested)) {
        return {
          content:
            `chat_id ${requested} is not an authorized chat. telegram_send can only ` +
            `message the owner's configured chat(s): ${allowed.join(", ")}.`,
          isError: true,
        };
      }
      targets = [requested];
    } else {
      targets = allowed;
    }

    // Idempotency: same text to the same target(s) within the window is treated
    // as a duplicate so a retrying scheduled job doesn't spam the user.
    const fp = fingerprintOf("telegram_send", targets.join(","), text);
    const prior = recentlyDone("telegram_send", fp, TELEGRAM_SEND_WINDOW_MS);
    if (prior) {
      return {
        content: `Identical Telegram message was already sent ${describeAge(prior.ageMs)}. Skipped to avoid a duplicate ping.`,
        metadata: { skipped: "duplicate", ageMs: prior.ageMs },
      };
    }

    // Match the reply path's formatting exactly (bootstrap-bridges.ts): the
    // channel-formatter MarkdownV2-escapes the text so Telegram renders it
    // correctly; bridge.sendMessage re-chunks at 4000 chars.
    const wire = formatForChannel(text, "telegram").join("\n\n");

    const results: string[] = [];
    let anyOk = false;
    for (const chatId of targets) {
      const ok = await bridge.sendMessage(chatId, wire);
      if (ok) { anyOk = true; results.push(`sent to ${chatId}`); }
      else results.push(`FAILED to ${chatId}`);
    }
    if (anyOk) markDone("telegram_send", fp, results.join("; "));
    return { content: `Telegram: ${results.join("; ")}.`, isError: !anyOk };
  },
};

export const telegramTools: ToolDefinition[] = [telegramSend];
