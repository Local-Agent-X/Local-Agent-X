import type { IntegrationConfig } from "../types.js";

export const whatsappIntegration: IntegrationConfig = {
  id: "whatsapp",
  name: "WhatsApp",
  icon: "💬",
  description: "Chat with your agent from anywhere via WhatsApp — just scan a QR code to connect",
  authType: "api_key",
  authInstructions: "No API keys needed! Just:\n1. Go to Settings → WhatsApp\n2. Click Connect\n3. Scan the QR code with WhatsApp on your phone (Linked Devices → Link a Device)\n4. Done — message yourself to talk to your agent",
  baseUrl: "http://localhost",
  docsUrl: "https://github.com/WhiskeySockets/Baileys",
  secretName: "WHATSAPP_CONNECTED",
  endpoints: [
    { name: "Connect", method: "POST", path: "/api/whatsapp/connect", description: "Start connection and get QR code" },
    { name: "Status", method: "GET", path: "/api/whatsapp/status", description: "Check connection status" },
    { name: "Send Message", method: "POST", path: "/api/whatsapp/send", description: "Send a message to a WhatsApp number", params: { to: { type: "string", required: true, description: "Phone number with country code" }, message: { type: "string", required: true, description: "Message text" } } },
    { name: "Disconnect", method: "POST", path: "/api/whatsapp/disconnect", description: "Disconnect WhatsApp" },
  ],
  headers: {},
  enabled: true,
  installed: false,
  builtin: true,
};
