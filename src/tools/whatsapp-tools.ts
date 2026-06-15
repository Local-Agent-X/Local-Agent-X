import type { ToolDefinition, ToolResult } from "../types.js";
import { getWhatsAppBridgeInstance } from "../whatsapp-bridge/index.js";
import { formatForChannel } from "../channel-formatter.js";
import { recentlyDone, markDone, fingerprintOf, describeAge } from "./idempotency.js";

// A scheduled job that retries shouldn't double-ping the user with the same text.
const WHATSAPP_SEND_WINDOW_MS = 60_000;

/** Digits-only form, matching how toJid() normalizes a number for comparison. */
function normNumber(s: string): string { return s.replace(/\D/g, ""); }

export const whatsappSend: ToolDefinition = {
  name: "whatsapp_send",
  description:
    "Proactively send a WhatsApp message to the owner — a scheduled reminder, " +
    "check-in, accountability nudge, or alert. Use this to message the user on " +
    "WhatsApp OUTSIDE of replying to one of their messages (replies happen " +
    "automatically). Typical use: from a scheduled mission/cron. Sends to the " +
    "linked account's own number (self-chat) by default; only pass `phone` to " +
    "target a specific already-authorized number. Requires the WhatsApp bridge " +
    "to be linked and connected (Settings → WhatsApp).",
  parameters: {
    type: "object",
    properties: {
      text: { type: "string", description: "Message text to send. WhatsApp markdown (*bold*, _italic_) supported." },
      phone: {
        type: "string",
        description:
          "Optional. A specific authorized phone number to send to. Defaults to the owner's own number (self-chat).",
      },
    },
    required: ["text"],
  },
  async execute(args: Record<string, unknown>): Promise<ToolResult> {
    const text = String(args.text ?? "").trim();
    if (!text) return { content: "whatsapp_send: 'text' is required and cannot be empty.", isError: true };

    const bridge = getWhatsAppBridgeInstance();
    if (!bridge) {
      return {
        content: "WhatsApp is not set up. Link a device (Settings → WhatsApp, scan the QR) first.",
        isError: true,
      };
    }

    const status = await bridge.getStatus();
    if (status.state !== "connected") {
      return {
        content:
          `WhatsApp bridge is not connected (state: ${status.state}` +
          `${status.error ? `: ${status.error}` : ""}). Link/connect it in Settings → WhatsApp.`,
        isError: true,
      };
    }
    if (!status.phone) {
      return { content: "WhatsApp is connected but the linked phone number is unknown — reconnect from Settings.", isError: true };
    }

    // Authorized targets = the owner's own number (self-chat) + any explicitly
    // allowed numbers. Confine sends to these — a prompt-injected `phone` must
    // not be able to make the agent DM an arbitrary attacker number. The egress
    // kernel gate is the outer wall; this is the inner allowlist.
    const authorized = new Set([status.phone, ...status.allowedNumbers].map(normNumber).filter(Boolean));

    let target: string;
    const requested = args.phone != null ? String(args.phone).trim() : "";
    if (requested) {
      if (!authorized.has(normNumber(requested))) {
        return {
          content:
            `phone ${requested} is not an authorized number. whatsapp_send can only ` +
            `message the owner's own number or an allowed number (${[...authorized].join(", ")}).`,
          isError: true,
        };
      }
      target = requested;
    } else {
      target = status.phone; // default: self-chat
    }

    // Idempotency: same text to the same target within the window is a duplicate,
    // so a retrying scheduled job doesn't spam the user.
    const fp = fingerprintOf("whatsapp_send", normNumber(target), text);
    const prior = recentlyDone("whatsapp_send", fp, WHATSAPP_SEND_WINDOW_MS);
    if (prior) {
      return {
        content: `Identical WhatsApp message was already sent ${describeAge(prior.ageMs)}. Skipped to avoid a duplicate ping.`,
        metadata: { skipped: "duplicate", ageMs: prior.ageMs },
      };
    }

    // Match the reply path's formatting (bootstrap-bridges.ts): the channel-
    // formatter converts to WhatsApp markdown flavor; sendMessage chunks + JIDs it.
    const wire = formatForChannel(text, "whatsapp").join("\n\n");

    const ok = await bridge.sendMessage(target, wire);
    return ok
      ? { content: `WhatsApp: sent to ${target}.` }
      : { content: `WhatsApp: FAILED to send to ${target} (bridge send returned false).`, isError: true };
  },
};

export const whatsappTools: ToolDefinition[] = [whatsappSend];
