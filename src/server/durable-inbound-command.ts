import type { BridgeReply } from "../whatsapp-bridge/index.js";
import type { MessagingChannelId } from "../session/channel-registry.js";
import { getVoicePref } from "../bridge-voice/index.js";
import {
  acknowledgeInboundDelivery,
  claimInboundDelivery,
  hasInboundDeliveryPart,
  markInboundDeliveryPart,
  markInboundResponseReady,
  prepareInboundCommand,
  readInboundDeliveryPlan,
  releaseInboundClaim,
  writeInboundDeliveryPlan,
  type DurableInboundCommandPlan,
  type PersistedInboundRequest,
} from "./inbound-delivery-store.js";

export async function runDurableInboundCommand(
  channel: MessagingChannelId,
  request: PersistedInboundRequest,
  plan: DurableInboundCommandPlan,
  execute: (plan: DurableInboundCommandPlan) => Promise<string> | string,
): Promise<BridgeReply | null> {
  const delivery = claimInboundDelivery({
    channel,
    deliveryId: request.deliveryId,
    sessionId: request.sessionId,
    text: request.deliveryFingerprint ?? request.text,
    request,
  });
  if (!delivery.acquired) {
    return delivery.reason === "delivered_duplicate" ? null : { text: "", deferDelivery: true };
  }
  if (!readInboundDeliveryPlan(delivery.claim)) {
    const mode = request.preferVoiceReply || getVoicePref(channel, request.from) ? "voice" : "text";
    if (!writeInboundDeliveryPlan(delivery.claim, { mode })) {
      throw new Error("durable command transport plan publication lost its claim");
    }
  }
  if (delivery.mode === "replay") return withAcknowledgement(delivery.reply, delivery.claim);
  if (delivery.mode === "recover") return { text: "", deferDelivery: true };
  const durablePlan = delivery.mode === "command" ? delivery.plan : plan;
  if (delivery.mode === "execute" && !prepareInboundCommand(delivery.claim, durablePlan)) {
    throw new Error("durable command plan publication lost its claim");
  }
  let text: string;
  try {
    text = await execute(durablePlan);
  } catch (error) {
    if (!releaseInboundClaim(delivery.claim)) throw new Error("durable command failure lost its recovery claim", { cause: error });
    throw error;
  }
  const reply = { text, speakable: text };
  if (!markInboundResponseReady(delivery.claim, reply)) throw new Error("durable command response publication lost its claim");
  return withAcknowledgement(reply, delivery.claim);
}

function withAcknowledgement(
  reply: { text: string; speakable: string },
  claim: { receiptId: string; generation: number },
): BridgeReply {
  return {
    ...reply,
    isDeliveryPartComplete: part => hasInboundDeliveryPart(claim, part),
    acknowledgeDeliveryPart: async part => {
      if (!markInboundDeliveryPart(claim, part)) throw new Error("durable command part acknowledgement lost its claim");
    },
    readDeliveryPlan: () => readInboundDeliveryPlan(claim),
    writeDeliveryPlan: async plan => {
      if (!writeInboundDeliveryPlan(claim, plan)) throw new Error("durable command delivery plan lost its claim");
    },
    acknowledgeDelivery: async (delivered) => {
      if (!acknowledgeInboundDelivery(claim, delivered)) throw new Error("durable command acknowledgement lost its claim");
    },
  };
}
