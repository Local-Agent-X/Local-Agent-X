import { describe, expect, it, vi } from "vitest";

const logs = vi.hoisted(() => [] as string[]);
vi.mock("../logger.js", () => ({
  createLogger: () => ({
    info: (m: string) => logs.push(m),
    warn: (m: string) => logs.push(m),
    error: (m: string) => logs.push(m),
    debug: () => undefined,
  }),
}));

import { candidateType, weriftTurnUrl, watchPeerDiagnostics, logChannelState } from "./peer-diagnostics.js";

describe("candidateType / weriftTurnUrl", () => {
  it("reads the typ of a candidate line", () => {
    expect(candidateType("candidate:1 1 udp 2130706431 10.0.0.2 5000 typ host generation 0")).toBe("host");
    expect(candidateType("candidate:2 1 udp 16777215 1.2.3.4 61000 typ relay raddr 5.6.7.8 rport 4000")).toBe("relay");
    expect(candidateType("")).toBe("unknown");
  });

  it("names the one TURN url werift will use: the first turn: entry", () => {
    expect(weriftTurnUrl(["stun:s:3478", "turn:t:3478?transport=udp", "turn:t:53?transport=udp", "turns:t:5349?transport=tcp"]))
      .toBe("turn:t:3478?transport=udp");
    expect(weriftTurnUrl(["stun:s:3478", "turns:t:5349?transport=tcp"])).toBeNull();
  });
});

// A real loopback pair: the desktop log must say ICE connected, which route it
// took, and that the chat channel opened — the lines the cellular field report
// had no way to see.
describe("watchPeerDiagnostics on a live werift pair", () => {
  it("logs gathering, ICE connected, the selected route and channel open — never an address", async () => {
    logs.length = 0;
    const { RTCPeerConnection } = await import("werift");
    const desktop = new RTCPeerConnection({});
    const phone = new RTCPeerConnection({});
    const diag = watchPeerDiagnostics(desktop, "phone", []);
    desktop.onIceCandidate.subscribe((c) => { if (c) void phone.addIceCandidate(c.toJSON()); });
    phone.onIceCandidate.subscribe((c) => {
      if (!c) return;
      diag.noteRemoteCandidate(c.candidate);
      void desktop.addIceCandidate(c.toJSON());
    });
    const dc = desktop.createDataChannel("chat");
    const opened = new Promise<void>((resolve) => dc.stateChanged.subscribe((s) => {
      logChannelState("phone", "chat", s);
      if (s === "open") resolve();
    }));
    await desktop.setLocalDescription(await desktop.createOffer());
    await phone.setRemoteDescription(desktop.localDescription!);
    await phone.setLocalDescription(await phone.createAnswer());
    await desktop.setRemoteDescription(phone.localDescription!);
    await opened;
    await vi.waitFor(() => expect(logs.some((l) => l.includes("route: desktop host"))).toBe(true), { timeout: 5000 });

    expect(logs.some((l) => l.includes("relay via NONE"))).toBe(true);
    expect(logs.some((l) => /ICE (connected|completed)/.test(l))).toBe(true);
    expect(logs).toContain("[rtc phone] channel chat open");
    // No IPv4 address leaks into the log.
    expect(logs.join("\n")).not.toMatch(/\b\d{1,3}(\.\d{1,3}){3}\b/);
    await desktop.close();
    await phone.close();
  }, 15000);
});
