import { listRecoverableInboundRequests } from "../server/inbound-delivery-store.js";
import { toJid } from "./text-utils.js";
import type { BridgeReply, WhatsAppBridgeConfig } from "./types.js";

export async function drainRecoverableWhatsApp(deps: {
  onMessage: WhatsAppBridgeConfig["onMessage"];
  dispatch: (jid: string, phone: string, reply: BridgeReply) => Promise<boolean>;
}): Promise<boolean> {
  let retry = false;
  const errors: unknown[] = [];
  for (const request of listRecoverableInboundRequests("whatsapp")) {
    try {
      const raw = await deps.onMessage(request);
      if (!raw) continue;
      const reply = typeof raw === "string" ? { text: raw, speakable: raw } : raw;
      if (reply.deferDelivery) { retry = true; continue; }
      let delivered: boolean;
      try {
        delivered = await deps.dispatch(request.deliveryTarget ?? toJid(request.from), request.from, reply);
      } catch (error) {
        try {
          await reply.acknowledgeDelivery?.(false);
        } catch (releaseError) {
          errors.push(releaseError);
          continue;
        }
        errors.push(error);
        continue;
      }
      await reply.acknowledgeDelivery?.(delivered);
      if (!delivered) retry = true;
    } catch (error) {
      errors.push(error);
    }
  }
  if (errors.length === 1) throw errors[0];
  if (errors.length > 1) throw new AggregateError(errors, "multiple WhatsApp durable receipts failed");
  return retry;
}

export function createWhatsAppDurableDrainer(deps: {
  onMessage: WhatsAppBridgeConfig["onMessage"];
  dispatch: (jid: string, phone: string, reply: BridgeReply) => Promise<boolean>;
  isConnected: () => boolean;
  onError: (error: Error) => void;
  retryDelayMs?: number;
}): () => void {
  let running = false;
  const trigger = (): void => {
    if (running || !deps.isConnected()) return;
    running = true;
    void drainRecoverableWhatsApp(deps).then(
      retry => schedule(retry),
      error => {
        deps.onError(error as Error);
        schedule(true);
      },
    );
  };
  const schedule = (retry: boolean): void => {
    running = false;
    if (!retry || !deps.isConnected()) return;
    const timer = setTimeout(trigger, deps.retryDelayMs ?? 5_000);
    timer.unref?.();
  };
  return trigger;
}
