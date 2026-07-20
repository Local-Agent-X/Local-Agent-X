import { getMessagingBridge, setMessagingBridge } from "../session/channel-registry.js";
import type { WhatsAppBridge } from "./index.js";

export function setWhatsAppBridgeInstance(bridge: WhatsAppBridge | null): void {
  setMessagingBridge("whatsapp", bridge);
}

export function getWhatsAppBridgeInstance(): WhatsAppBridge | null {
  return getMessagingBridge("whatsapp");
}
