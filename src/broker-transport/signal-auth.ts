// SignalAuthenticator — this desktop's half of device-key signaling (the agentxos
// signal-auth contract, vendor/signal-auth.ts). The broker relays every offer and
// answer, and the DTLS fingerprints in them are what the encrypted link is keyed to, so
// this is where a broker that swapped one gets caught:
//
//   - every offer this desktop sends is signed with its identity key, which the phone
//     learned from the pairing QR;
//   - every answer is checked before it is applied. An answer that proves, with the
//     one-time secret in the QR this desktop last showed, that its key came from the
//     phone that scanned it pins that key (replacing an older pin: a reinstalled phone
//     re-pairs by scanning again). Otherwise a pairing with a pinned key needs a valid
//     signature from it, or the answer is refused and never reaches the peer. A pairing
//     without one is accepted as before (the owner's call: an existing pairing keeps
//     working until the phone is re-paired by QR).
//
// Whether a pairing is pinned is read from this desktop's own account file, never from
// anything the broker sends, so the broker cannot downgrade a pinned pairing.
//
// Pure over injected deps (account state, signing, the refusal sink) so it unit-tests
// offline with real keys.

import { createHmac, createPublicKey, timingSafeEqual, verify } from "node:crypto";
import { pairingProofMessage, signalAuthMessage, type SignalAuth, type SignalAuthInput } from "./vendor/index.js";
import type { AccountState } from "./account/storage.js";
import { createLogger } from "../logger.js";

const logger = createLogger("broker-transport.signal-auth");

export interface SignalAuthDeps {
  loadState: () => AccountState | null;
  updateState: (patch: Partial<AccountState>) => AccountState | null;
  /** Sign a UTF-8 message with this desktop's identity key (unpadded base64url). */
  sign: (message: string) => string;
  /** An answer was refused: say so where the owner will see it. */
  onRefused: (message: string) => void;
}

export interface SignalAuthenticator {
  /** The auth to send with an offer, or undefined when the desktop isn't paired. */
  signOffer(offerSdp: string): SignalAuth | undefined;
  /** True when the answer may be applied to the offer it answers. */
  checkAnswer(offerSdp: string, answerSdp: string, auth: SignalAuth | undefined): boolean;
}

export const REFUSED_ANSWER_MESSAGE =
  "A connection claiming to be your phone was refused: it wasn't signed by the phone you paired. " +
  "If you reinstalled the phone app, show a pairing QR here and scan it again.";

/** The phone key the current pairing is pinned to, or null when it isn't. */
export function pinnedKeyFor(state: AccountState): string | null {
  const pin = state.pinnedPhone;
  return pin && state.pairedPhoneId && pin.deviceId === state.pairedPhoneId ? pin.key : null;
}

export function createSignalAuthenticator(deps: SignalAuthDeps): SignalAuthenticator {
  return {
    signOffer(offerSdp) {
      const state = deps.loadState();
      if (!state?.pairedPhoneId) return undefined;
      const input: SignalAuthInput = {
        kind: "offer",
        desktopDeviceId: state.deviceId,
        phoneDeviceId: state.pairedPhoneId,
        offerSdp,
      };
      return { sig: deps.sign(signalAuthMessage(input)) };
    },

    checkAnswer(offerSdp, answerSdp, auth) {
      const state = deps.loadState();
      if (!state?.pairedPhoneId) return false;
      const input: SignalAuthInput = {
        kind: "answer",
        desktopDeviceId: state.deviceId,
        phoneDeviceId: state.pairedPhoneId,
        offerSdp,
        answerSdp,
      };
      if (auth?.pair && state.pairingSecret && provesScan(state.pairingSecret, input, auth)) {
        deps.updateState({ pinnedPhone: { deviceId: state.pairedPhoneId, key: auth.pair.key }, pairingSecret: undefined });
        logger.info(`[broker-transport] pinned the signing key of phone ${state.pairedPhoneId}`);
        return true;
      }
      if (auth?.pair) logger.warn("[broker-transport] a pairing proof did not check out against the last QR shown");
      const pinned = pinnedKeyFor(state);
      if (!pinned) return true;
      if (auth && verifySignature(pinned, signalAuthMessage(input), auth.sig)) return true;
      logger.warn(`[broker-transport] refused an answer not signed by the pinned key of phone ${state.pairedPhoneId}`);
      deps.onRefused(REFUSED_ANSWER_MESSAGE);
      return false;
    },
  };
}

/** The phone's key signed this answer, and the MAC shows it knew the QR's secret. */
function provesScan(secret: string, input: SignalAuthInput, auth: SignalAuth): boolean {
  const pair = auth.pair!;
  if (!verifySignature(pair.key, signalAuthMessage(input), auth.sig)) return false;
  const expected = createHmac("sha256", Buffer.from(secret, "base64url"))
    .update(pairingProofMessage(pair.key, input), "utf8")
    .digest();
  const got = Buffer.from(pair.mac, "base64url");
  return got.length === expected.length && timingSafeEqual(got, expected);
}

/** Verify an ed25519 signature by a raw (base64url) public key. False on any malformed
 *  input: the key and signature came off the wire. */
export function verifySignature(rawKey: string, message: string, sig: string): boolean {
  try {
    const key = createPublicKey({ key: { kty: "OKP", crv: "Ed25519", x: rawKey }, format: "jwk" });
    return verify(null, Buffer.from(message, "utf8"), key, Buffer.from(sig, "base64url"));
  } catch {
    return false;
  }
}
