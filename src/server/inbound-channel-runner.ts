import { formatForChannel, getChannelConfig } from "../channel-formatter.js";
import { forwardBridgeMedia } from "./bridge-media-forward.js";
import { runChatTurn } from "../routes/chat/run-chat-turn.js";
import { buildChannelContext, resolveSession, type ChannelType } from "../session/router.js";
import { getMessagingChannelDefinition, type MessagingChannelId } from "../session/channel-registry.js";
import type { ServerContext } from "../server-context.js";
import type { ServerEvent } from "../types.js";
import type { BridgeReply } from "../whatsapp-bridge/index.js";
import { bindInboundOperation, claimInboundDelivery, completeInboundDelivery } from "./inbound-delivery-store.js";

export interface InboundChannelPayload {
  from: string;
  name: string;
  text: string;
  sessionId: string;
  deliveryId?: string;
}

export interface InboundChannelRunnerDeps {
  getContext: () => Promise<ServerContext>;
}

/** Messaging transport adapter over the one canonical chat-turn runner. */
export function createInboundChannelRunner(deps: InboundChannelRunnerDeps) {
  return async function runInboundChannelTurn(
    platform: MessagingChannelId,
    payload: InboundChannelPayload,
  ): Promise<BridgeReply | null> {
    const ctx = await deps.getContext();
    const channelType = platform as ChannelType;
    const definition = getMessagingChannelDefinition(platform);
    const route = resolveSession(channelType, payload.from, payload.sessionId);
    const delivery = payload.deliveryId ? claimInboundDelivery({
      channel: platform,
      deliveryId: payload.deliveryId,
      sessionId: route.sessionKey,
      text: payload.text,
    }) : null;
    if (delivery && !delivery.acquired) return null;
    const channelConfig = getChannelConfig(channelType);
    const bridgeContext = `\n\n[${definition.displayName} bridge] ${buildChannelContext(route)}. ` +
      `Message from ${payload.name} (${payload.from}). Keep responses concise — max ~` +
      `${channelConfig.maxTextLength === Infinity ? "unlimited" : channelConfig.maxTextLength} chars. ` +
      (channelConfig.markdownFlavor === "plain" ? "Use plain text only. "
        : channelConfig.markdownFlavor === "whatsapp" ? "Use minimal formatting. " : "");

    let text = "";
    let opId = "";
    let error = "";
    const sink = (event: ServerEvent) => {
      if (event.type === "stream" && "delta" in event && typeof event.delta === "string") text += event.delta;
      else if (event.type === "stream" && "replace" in event && event.replace === true) text = event.text;
      else if (event.type === "chat_op_started" && typeof event.opId === "string") {
        opId = event.opId;
        if (delivery?.acquired && !bindInboundOperation(delivery.claim, opId)) {
          throw new Error("inbound delivery claim was lost while binding its canonical operation");
        }
      }
      else if (event.type === "error" && !error) error = event.message;
    };

    await runChatTurn({
      sessionId: route.sessionKey,
      message: payload.text,
      attachments: [],
      projectId: null,
      ctx,
      requestRole: "operator",
      sseSink: sink,
      channel: platform,
      bridgeContext,
      skipMemory: true,
      maxHistory: 30,
      sessionTitle: `${definition.displayName}: ${payload.name}`,
    });
    if (opId) {
      await forwardBridgeMedia({
        canonicalOpId: opId,
        channelType,
        platform: definition.displayName,
        from: payload.from,
        sessionKey: route.sessionKey,
        getWhatsappBridge: () => ctx.whatsappBridge,
        getTelegramBridge: () => ctx.telegramBridge,
      });
    }
    if (delivery?.acquired && !completeInboundDelivery(delivery.claim)) {
      throw new Error("inbound delivery claim was lost before completion");
    }

    const raw = text.trim() || (error ? `Something went wrong: ${error}` : "Done.");
    return {
      text: formatForChannel(raw, channelType).join("\n\n"),
      speakable: raw,
    };
  };
}
