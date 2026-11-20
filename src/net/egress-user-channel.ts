/**
 * The egress judge for the user's own channels: what the agent sends the user
 * on the phone (broker-transport/phone-projection.ts) and in a Telegram or
 * WhatsApp chat (server/bridge-media-forward.ts). Taint does not refuse there
 * (EGRESS_CHANNEL_TAINT "none"); the session's canary and a secret-shaped
 * value do.
 */
import { scanForSecrets } from "../security/secrets/secret-scanner.js";
import { checkCanariesInPayload } from "../threat/canaries.js";
import { judgeEgress, type EgressJudgement, type UserChannelEgressState } from "./egress-judge.js";

function liveState(scanSecrets: boolean): UserChannelEgressState {
  return {
    checkCanariesInPayload,
    containsSecretShape: (payload) => (scanSecrets ? !scanForSecrets(payload).clean : null),
  };
}

/**
 * Judge `payload` before it goes to the user. `scanSecrets: false` for bytes
 * that carry no text (an image without embedded text), where the shape scan
 * would only find noise.
 */
export function judgeUserChannelEgress(sessionId: string, payload: string, opts: { scanSecrets?: boolean } = {}): EgressJudgement {
  return judgeEgress(liveState(opts.scanSecrets ?? true), "user-channel", sessionId, payload);
}
