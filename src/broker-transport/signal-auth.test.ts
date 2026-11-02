// Device-key signaling, end to end on the desktop side with real ed25519 keys: what the
// authenticator signs and accepts, and that BrokerDialer never hands a refused answer to
// the peer. The phone's half is played here with node:crypto over the same vendored
// message builders the phone app uses.

import { describe, it, expect } from "vitest";
import { createHmac, generateKeyPairSync, sign, type KeyObject } from "node:crypto";
import { createSignalAuthenticator, verifySignature, REFUSED_ANSWER_MESSAGE } from "./signal-auth.js";
import { BrokerVoiceDialer, type VoicePeerLike } from "./broker-voice-dialer.js";
import { pairingProofMessage, signalAuthMessage, type SignalAuth, type SignalAuthInput } from "./vendor/index.js";
import type { AccountState } from "./account/storage.js";
import type { SocketAdapter } from "./vendor/socket-adapter.js";
import type { VoiceSession } from "../voice/audio-ws.js";

const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

function keypair(): { raw: string; priv: KeyObject } {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  return { raw: publicKey.export({ format: "jwk" }).x as string, priv: privateKey };
}
const signB64 = (priv: KeyObject, msg: string): string => sign(null, Buffer.from(msg, "utf8"), priv).toString("base64url");

const DESKTOP = keypair();
const PHONE = keypair();
const SECRET = Buffer.alloc(32, 9).toString("base64url");
const answerInput = (offerSdp: string, answerSdp: string, phoneDeviceId = "phone-9"): SignalAuthInput => ({
  kind: "answer", desktopDeviceId: "desk-1", phoneDeviceId, offerSdp, answerSdp,
});

/** The phone's answer auth: a signature, plus the scan proof when it holds the QR secret. */
function phoneAuth(offerSdp: string, answerSdp: string, opts: { key?: { raw: string; priv: KeyObject }; secret?: string } = {}): SignalAuth {
  const key = opts.key ?? PHONE;
  const input = answerInput(offerSdp, answerSdp);
  const sig = signB64(key.priv, signalAuthMessage(input));
  if (!opts.secret) return { sig };
  const mac = createHmac("sha256", Buffer.from(opts.secret, "base64url")).update(pairingProofMessage(key.raw, input)).digest("base64url");
  return { sig, pair: { key: key.raw, mac } };
}

function harness(initial: Partial<AccountState> = {}) {
  let state: AccountState = { email: "a@b.co", sessionToken: "T", deviceId: "desk-1", pairedPhoneId: "phone-9", ...initial };
  const refused: string[] = [];
  const auth = createSignalAuthenticator({
    loadState: () => state,
    updateState: (patch) => (state = { ...state, ...patch }),
    sign: (message) => signB64(DESKTOP.priv, message),
    onRefused: (m) => refused.push(m),
  });
  return { auth, refused, state: () => state };
}

describe("signal auth — offers", () => {
  it("signs the offer so the phone can check it against the key in the QR", () => {
    const { auth } = harness();
    const signed = auth.signOffer("OFFER")!;
    const message = signalAuthMessage({ kind: "offer", desktopDeviceId: "desk-1", phoneDeviceId: "phone-9", offerSdp: "OFFER" });
    expect(verifySignature(DESKTOP.raw, message, signed.sig)).toBe(true);
    expect(verifySignature(DESKTOP.raw, message.replace("OFFER", "SWAPPED"), signed.sig)).toBe(false);
  });
});

describe("signal auth — a pairing from before pinning", () => {
  it("still accepts an unsigned answer, as the owner asked", () => {
    const { auth, refused } = harness();
    expect(auth.checkAnswer("O", "A", undefined)).toBe(true);
    expect(refused).toEqual([]);
  });

  it("pins the phone's key when its answer proves it scanned the QR this desktop showed", () => {
    const { auth, state } = harness({ pairingSecret: SECRET });
    expect(auth.checkAnswer("O", "A", phoneAuth("O", "A", { secret: SECRET }))).toBe(true);
    expect(state().pinnedPhone).toEqual({ deviceId: "phone-9", key: PHONE.raw });
    expect(state().pairingSecret).toBeUndefined(); // one-time
  });

  it("does not pin a key whose proof used some other secret (a relay can't know the QR's)", () => {
    const { auth, state } = harness({ pairingSecret: SECRET });
    const other = Buffer.alloc(32, 1).toString("base64url");
    expect(auth.checkAnswer("O", "A", phoneAuth("O", "A", { secret: other }))).toBe(true);
    expect(state().pinnedPhone).toBeUndefined();
  });

  it("does not pin when the proof's signature isn't over this offer and answer", () => {
    const { auth, state } = harness({ pairingSecret: SECRET });
    expect(auth.checkAnswer("O", "A", phoneAuth("O", "DIFFERENT", { secret: SECRET }))).toBe(true);
    expect(state().pinnedPhone).toBeUndefined();
  });
});

describe("signal auth — a pinned pairing", () => {
  const pinned = { pinnedPhone: { deviceId: "phone-9", key: PHONE.raw } };

  it("accepts an answer signed by the pinned key", () => {
    const { auth, refused } = harness(pinned);
    expect(auth.checkAnswer("O", "A", phoneAuth("O", "A"))).toBe(true);
    expect(refused).toEqual([]);
  });

  it("refuses an unsigned answer and says why on the account page", () => {
    const { auth, refused } = harness(pinned);
    expect(auth.checkAnswer("O", "A", undefined)).toBe(false);
    expect(refused).toEqual([REFUSED_ANSWER_MESSAGE]);
  });

  it("refuses an answer signed by any other key", () => {
    const { auth } = harness(pinned);
    expect(auth.checkAnswer("O", "A", phoneAuth("O", "A", { key: keypair() }))).toBe(false);
  });

  it("refuses a pinned phone's genuine answer replayed against a different offer", () => {
    const { auth } = harness(pinned);
    expect(auth.checkAnswer("NEW_OFFER", "A", phoneAuth("OLD_OFFER", "A"))).toBe(false);
  });

  it("re-pins a reinstalled phone that scans a fresh QR", () => {
    const fresh = keypair();
    const { auth, state } = harness({ ...pinned, pairingSecret: SECRET });
    expect(auth.checkAnswer("O", "A", phoneAuth("O", "A", { key: fresh, secret: SECRET }))).toBe(true);
    expect(state().pinnedPhone?.key).toBe(fresh.raw);
  });

  it("treats a different paired phone as unpinned, not as the old phone's key", () => {
    const { auth, refused } = harness({ pinnedPhone: { deviceId: "old-phone", key: PHONE.raw } });
    expect(auth.checkAnswer("O", "A", undefined)).toBe(true);
    expect(refused).toEqual([]);
  });
});

// The gate where it matters: a refused answer never reaches the peer.
class FakeSocket implements SocketAdapter {
  sent: string[] = [];
  private msg: ((d: string) => void) | null = null;
  send(text: string): void { this.sent.push(text); }
  close(): void { /* recorded elsewhere */ }
  onMessage(h: (d: string) => void): void { this.msg = h; }
  onClose(): void { /* unused */ }
  deliver(frame: unknown): void { this.msg?.(JSON.stringify(frame)); }
}

function startedDialer(initial: Partial<AccountState>) {
  const socket = new FakeSocket();
  const answers: string[] = [];
  const closed = { count: 0 };
  const h = harness(initial);
  const peer: VoicePeerLike = {
    createOffer: () => Promise.resolve("VOICE_OFFER"),
    applyAnswer: (sdp) => { answers.push(sdp); return Promise.resolve(); },
    addRemoteIce: () => Promise.resolve(),
    writeTtsPcm: () => {},
    interruptTts: () => {},
    close: () => Promise.resolve(),
  };
  new BrokerVoiceDialer({
    socket,
    sessionFactory: (): VoiceSession => ({ onMicFrame: () => {}, close: () => {} }),
    createPeer: () => Promise.resolve(peer),
    onClosed: () => { closed.count++; },
    signalAuth: h.auth,
  });
  socket.deliver({ type: "joined", role: "desktop", peerPresent: true });
  socket.deliver({ type: "ice-servers", iceServers: [{ urls: "stun:x" }], ttlSeconds: 300 });
  return { socket, answers, closed, ...h };
}

describe("BrokerDialer — the answer gate", () => {
  it("sends its offer signed", async () => {
    const { socket } = startedDialer({});
    await flush();
    const offer = socket.sent.map((s) => JSON.parse(s)).find((f) => f.signal?.kind === "offer");
    expect(offer.signal.sdp).toBe("VOICE_OFFER");
    expect(typeof offer.signal.auth.sig).toBe("string");
  });

  it("hands a pinned phone's signed answer to the peer", async () => {
    const { socket, answers } = startedDialer({ pinnedPhone: { deviceId: "phone-9", key: PHONE.raw } });
    await flush();
    socket.deliver({ type: "signal", signal: { kind: "answer", sdp: "ANS", auth: phoneAuth("VOICE_OFFER", "ANS") } });
    await flush();
    expect(answers).toEqual(["ANS"]);
  });

  it("never applies an answer the pinned phone didn't sign, and ends the dialer", async () => {
    const { socket, answers, closed, refused } = startedDialer({ pinnedPhone: { deviceId: "phone-9", key: PHONE.raw } });
    await flush();
    socket.deliver({ type: "signal", signal: { kind: "answer", sdp: "ANS", auth: phoneAuth("VOICE_OFFER", "ANS", { key: keypair() }) } });
    await flush();
    expect(answers).toEqual([]);
    expect(closed.count).toBe(1);
    expect(refused).toEqual([REFUSED_ANSWER_MESSAGE]);
  });
});
