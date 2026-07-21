import {
  acknowledgeBrowserProcessRelay,
  type ProcessRelayBrowserAck,
} from "../canonical-loop/public/process-relay.js";

export function handleProcessRelayAck(
  value: Record<string, unknown>,
  subscriptions: ReadonlySet<string>,
): boolean {
  if (value.type !== "process_relay_ack") return false;
  if (typeof value.opId !== "string" || typeof value.sessionId !== "string"
    || typeof value.generationId !== "string" || typeof value.deliveryId !== "string"
    || !Number.isSafeInteger(value.cursor)) return true;
  const ack = value as unknown as ProcessRelayBrowserAck;
  acknowledgeBrowserProcessRelay(ack, subscriptions.has(ack.sessionId));
  return true;
}
