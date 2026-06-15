import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { WhatsAppBridge } from "../src/whatsapp-bridge/index.js";
import { setWhatsAppBridgeInstance } from "../src/whatsapp-bridge/index.js";
import { whatsappSend } from "../src/tools/whatsapp-tools.js";
import { formatForChannel } from "../src/channel-formatter.js";

// Seam: whatsapp_send (tool) → WhatsAppBridge (transport). Registration across
// the registry / ARI class map / action map / policy is guarded by the coverage
// + orphan tests; this guards the tool's own boundary logic — most importantly
// that a proactive send is CONFINED to the owner number / allowed numbers, with
// digit-normalized matching, and defaults to self-chat.

type Sent = { to: string; text: string };

function stubBridge(over: Partial<{ state: string; phone: string | null; allowedNumbers: string[]; sendOk: boolean }>): { bridge: WhatsAppBridge; sent: Sent[] } {
  const sent: Sent[] = [];
  const state = over.state ?? "connected";
  const phone = over.phone === undefined ? "15551234567" : over.phone;
  const allowedNumbers = over.allowedNumbers ?? [];
  const sendOk = over.sendOk ?? true;
  const bridge = {
    getStatus: async () => ({ state, phone, qr: null, qrDataUrl: null, qrImageUrl: null, error: null, allowedNumbers, hasSavedSession: true }),
    sendMessage: async (to: string, text: string) => { sent.push({ to, text }); return sendOk; },
    sendToOwner: async (text: string) => { sent.push({ to: "OWNER_SELF", text }); return sendOk; },
  } as unknown as WhatsAppBridge;
  return { bridge, sent };
}

describe("whatsapp_send — boundary + confinement", () => {
  beforeEach(() => setWhatsAppBridgeInstance(null));
  afterEach(() => setWhatsAppBridgeInstance(null));

  it("errors when the bridge is not configured", async () => {
    const r = await whatsappSend.execute({ text: "hi alpha" });
    expect(r.isError).toBe(true);
    expect(r.content).toMatch(/not set up|link/i);
  });

  it("errors on empty text before touching the bridge", async () => {
    const { bridge, sent } = stubBridge({});
    setWhatsAppBridgeInstance(bridge);
    const r = await whatsappSend.execute({ text: "   " });
    expect(r.isError).toBe(true);
    expect(sent).toHaveLength(0);
  });

  it("errors when the bridge is not connected", async () => {
    const { bridge } = stubBridge({ state: "disconnected" });
    setWhatsAppBridgeInstance(bridge);
    const r = await whatsappSend.execute({ text: "hi bravo" });
    expect(r.isError).toBe(true);
    expect(r.content).toMatch(/not connected/i);
  });

  it("defaults to the owner's self-chat (via sendToOwner, @lid-correct), WhatsApp-formatted", async () => {
    const { bridge, sent } = stubBridge({ phone: "15551234567" });
    setWhatsAppBridgeInstance(bridge);
    const text = "Did you work out today? Don't slack!";
    const r = await whatsappSend.execute({ text });
    expect(r.isError).toBeFalsy();
    expect(sent).toEqual([{ to: "OWNER_SELF", text: formatForChannel(text, "whatsapp").join("\n\n") }]);
  });

  it("REFUSES an unauthorized number and does not send (confinement)", async () => {
    const { bridge, sent } = stubBridge({ phone: "15551234567" });
    setWhatsAppBridgeInstance(bridge);
    const r = await whatsappSend.execute({ text: "hi delta", phone: "19998887777" });
    expect(r.isError).toBe(true);
    expect(r.content).toMatch(/not an authorized number/i);
    expect(sent).toHaveLength(0);
  });

  it("allows an allowed number, matching despite formatting (digits-only)", async () => {
    const { bridge, sent } = stubBridge({ phone: "15551234567", allowedNumbers: ["16505550199"] });
    setWhatsAppBridgeInstance(bridge);
    const r = await whatsappSend.execute({ text: "hi echo", phone: "+1 (650) 555-0199" });
    expect(r.isError).toBeFalsy();
    expect(sent.map((s) => s.to)).toEqual(["+1 (650) 555-0199"]);
  });
});
