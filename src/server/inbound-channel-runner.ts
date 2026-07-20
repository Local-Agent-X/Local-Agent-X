import { formatForChannel, getChannelConfig } from "../channel-formatter.js";
import { persistBridgeMedia } from "../bridge-media-queue.js";
import { getVoicePref } from "../bridge-voice/index.js";
import { forwardBridgeMedia } from "./bridge-media-forward.js";
import { runChatTurn } from "../routes/chat/run-chat-turn.js";
import { buildChannelContext, resolveSession, type ChannelType } from "../session/router.js";
import { getMessagingChannelDefinition, type MessagingChannelId } from "../session/channel-registry.js";
import type { ServerContext } from "../server-context.js";
import type { ServerEvent } from "../types.js";
import type { BridgeReply } from "../whatsapp-bridge/index.js";
import {
  acknowledgeInboundDelivery,
  bindInboundOperation,
  claimInboundDelivery,
  hasInboundDeliveryPart,
  markInboundDeliveryPart,
  markInboundResponseReady,
  readInboundDeliveryPlan,
  releaseInboundClaim,
  writeInboundDeliveryPlan,
  type DurableInboundReply,
  type InboundDeliveryClaim,
} from "./inbound-delivery-store.js";

export interface InboundChannelPayload {
  from: string;
  name: string;
  text: string;
  sessionId: string;
  deliveryId?: string;
  deliveryFingerprint?: string;
  deliveryTarget?: string;
  preferVoiceReply?: boolean;
  intent?: "turn" | "steer";
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
      text: payload.deliveryFingerprint ?? payload.text,
      request: {
        from: payload.from, name: payload.name, text: payload.text, sessionId: payload.sessionId,
        deliveryId: payload.deliveryId!, deliveryFingerprint: payload.deliveryFingerprint,
        deliveryTarget: payload.deliveryTarget,
        preferVoiceReply: payload.preferVoiceReply,
        intent: payload.intent,
      },
    }) : null;
    if (delivery?.acquired && !readInboundDeliveryPlan(delivery.claim)) {
      const mode = payload.preferVoiceReply || getVoicePref(platform, payload.from) ? "voice" : "text";
      if (!writeInboundDeliveryPlan(delivery.claim, { mode })) {
        throw new Error("inbound delivery claim was lost before freezing its transport plan");
      }
    }
    if (delivery && !delivery.acquired) {
      return delivery.reason === "delivered_duplicate" ? null : { text: "", deferDelivery: true };
    }
    if (delivery?.acquired && delivery.mode === "replay") {
      if (delivery.opId && !(await forwardMedia(ctx, definition.displayName, channelType, payload.from, payload.deliveryTarget, route.sessionKey, delivery.opId))) {
        if (!acknowledgeInboundDelivery(delivery.claim, false)) throw new Error("inbound media retry lease was lost");
        return { text: "", deferDelivery: true };
      }
      return replyWithAcknowledgement(delivery.reply, delivery.claim);
    }
    if (delivery?.acquired && delivery.mode === "recover") {
      const recovered = await recoverInboundReply(delivery.opId, channelType);
      if (!recovered) {
        if (!releaseInboundClaim(delivery.claim)) throw new Error("inbound recovery lease was lost");
        return { text: "", deferDelivery: true };
      }
      if (!markInboundResponseReady(delivery.claim, recovered)) {
        throw new Error("inbound recovery lease was lost before publishing its response");
      }
      if (!(await forwardMedia(ctx, definition.displayName, channelType, payload.from, payload.deliveryTarget, route.sessionKey, delivery.opId))) {
        if (!acknowledgeInboundDelivery(delivery.claim, false)) throw new Error("inbound recovered media lease was lost");
        return { text: "", deferDelivery: true };
      }
      return replyWithAcknowledgement(recovered, delivery.claim);
    }
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
      ingressKey: delivery?.acquired ? delivery.claim.receiptId : undefined,
    });
    const raw = text.trim() || (error ? `Something went wrong: ${error}` : "Done.");
    const reply: DurableInboundReply = {
      text: formatForChannel(raw, channelType).join("\n\n"),
      speakable: raw,
    };
    if (opId) persistBridgeMedia(opId);
    if (delivery?.acquired && !markInboundResponseReady(delivery.claim, reply)) {
      throw new Error("inbound delivery claim was lost before publishing its response");
    }
    if (opId && !(await forwardMedia(ctx, definition.displayName, channelType, payload.from, payload.deliveryTarget, route.sessionKey, opId))) {
      if (delivery?.acquired && !acknowledgeInboundDelivery(delivery.claim, false)) {
        throw new Error("inbound media delivery lease was lost");
      }
      return { text: "", deferDelivery: true };
    }
    return delivery?.acquired ? replyWithAcknowledgement(reply, delivery.claim) : reply;
  };
}

async function recoverInboundReply(opId: string, channel: ChannelType): Promise<DurableInboundReply | null> {
  const [{ readOp }, { readOpMessages }] = await Promise.all([
    import("../ops/op-store.js"),
    import("../canonical-loop/index.js"),
  ]);
  const op = readOp(opId);
  const canonicalState = op?.canonical?.state;
  const terminal = op && (["completed", "failed", "cancelled"].includes(op.status)
    || (canonicalState && ["succeeded", "failed", "cancelled"].includes(canonicalState)));
  if (!terminal) return null;
  const raw = readOpMessages(opId)
    .filter((row) => row.role === "assistant" && !row.messageId.startsWith("hist-"))
    .map((row) => (row.content as { text?: unknown })?.text)
    .filter((text): text is string => typeof text === "string" && text.length > 0)
    .join("\n\n")
    .trim() || "Done.";
  return { text: formatForChannel(raw, channel).join("\n\n"), speakable: raw };
}

async function forwardMedia(
  ctx: ServerContext,
  platform: string,
  channelType: ChannelType,
  from: string,
  deliveryTarget: string | undefined,
  sessionKey: string,
  canonicalOpId: string,
): Promise<boolean> {
  return forwardBridgeMedia({
    canonicalOpId, channelType, platform, from, deliveryTarget, sessionKey,
    getWhatsappBridge: () => ctx.whatsappBridge,
    getTelegramBridge: () => ctx.telegramBridge,
  });
}

function replyWithAcknowledgement(reply: DurableInboundReply, claim: InboundDeliveryClaim): BridgeReply {
  return {
    ...reply,
    isDeliveryPartComplete: part => hasInboundDeliveryPart(claim, part),
    acknowledgeDeliveryPart: async part => {
      if (!markInboundDeliveryPart(claim, part)) {
        throw new Error("inbound delivery claim was lost before part acknowledgement");
      }
    },
    readDeliveryPlan: () => readInboundDeliveryPlan(claim),
    writeDeliveryPlan: async plan => {
      if (!writeInboundDeliveryPlan(claim, plan)) {
        throw new Error("inbound delivery claim was lost before plan acknowledgement");
      }
    },
    acknowledgeDelivery: async (delivered) => {
      if (!acknowledgeInboundDelivery(claim, delivered)) {
        throw new Error("inbound delivery claim was lost before transport acknowledgement");
      }
    },
  };
}
