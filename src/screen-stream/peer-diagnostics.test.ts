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

import { candidateType, weriftTurnUrl, watchPeerDiagnostics, logChannelState, summarizePairs } from "./peer-diagnostics.js";

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

describe("summarizePairs", () => {
  it("groups ICE checks by route kind and state", () => {
    const out = summarizePairs([
      { local: "relay", remote: "srflx", state: 4, nominated: false },
      { local: "relay", remote: "srflx", state: 4, nominated: false },
      { local: "relay", remote: "relay", state: 2, nominated: false },
      { local: "host", remote: "host", state: 3, nominated: true },
    ]);
    expect(out).toBe("relay→srflx failed ×2; relay→relay in-progress ×1; host→host succeeded (nominated) ×1");
  });

  it("says so when there are no pairs at all", () => {
    expect(summarizePairs([])).toBe("no candidate pairs");
  });
});

// The field failure: the answer arrives, the phone's routes never do, and the
// connection hangs in "connecting" with nothing logged. Now it reports what the
// checks are doing every 10 s, three times.
describe("watchPeerDiagnostics on a connection that never comes up", () => {
  it("logs the routes received and the checks while stuck connecting", async () => {
    logs.length = 0;
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    try {
      const { RTCPeerConnection } = await import("werift");
      const desktop = new RTCPeerConnection({});
      const phone = new RTCPeerConnection({});
      const diag = watchPeerDiagnostics(desktop, "phone", []);
      desktop.createDataChannel("chat");
      // SDP only, no real candidates: the phone's one route is unreachable
      // (TEST-NET-1), so its checks stay in flight and the peer hangs connecting.
      await desktop.setLocalDescription(await desktop.createOffer());
      await phone.setRemoteDescription({ type: "offer", sdp: desktop.localDescription!.sdp.replace(/a=candidate:.*\r\n/g, "") });
      await phone.setLocalDescription(await phone.createAnswer());
      await desktop.setRemoteDescription({ type: "answer", sdp: phone.localDescription!.sdp.replace(/a=(candidate:|end-of-candidates).*\r\n/g, "") });
      const unreachable = "candidate:1 1 udp 2130706431 192.0.2.1 9 typ host";
      diag.noteRemoteCandidate(unreachable);
      await desktop.addIceCandidate({ candidate: unreachable, sdpMid: "0", sdpMLineIndex: 0 });
      await vi.waitFor(() => expect(logs).toContain("[rtc phone] peer connecting"));

      await vi.advanceTimersByTimeAsync(10_000);
      const stuck = logs.find((l) => l.includes("still connecting after 10s")) ?? logs.join("\n");
      expect(stuck).toMatch(/phone routes received: host 1; checks: \w+→host (waiting|in-progress) ×\d/);
      expect(stuck).not.toMatch(/\d+\.\d+\.\d+\.\d+/);
      await vi.advanceTimersByTimeAsync(40_000);
      expect(logs.filter((l) => l.includes("still connecting after"))).toHaveLength(3);
      await desktop.close();
      await phone.close();
    } finally {
      vi.useRealTimers();
    }
  }, 15000);
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
    // werift's own "checking"/"completed" during gathering, before the answer, is
    // not reported as a connection: the first ICE line follows "peer connecting".
    const firstIce = logs.findIndex((l) => l.includes("] ICE "));
    expect(firstIce).toBeGreaterThan(logs.indexOf("[rtc phone] peer connecting"));
    expect(logs.some((l) => l.includes("no nominated candidate pair"))).toBe(false);
    expect(logs).toContain("[rtc phone] route: desktop host ↔ phone host");
    // No IPv4 address leaks into the log.
    expect(logs.join("\n")).not.toMatch(/\b\d{1,3}(\.\d{1,3}){3}\b/);
    await desktop.close();
    await phone.close();
  }, 15000);
});
