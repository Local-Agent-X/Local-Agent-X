/**
 * The egress judge: one decision, per outbound request, on whether the bytes
 * carry evidence that must not leave — the session's canary, or bytes from a
 * sensitive source the session read. Every enforcement point calls it; what
 * differs between them is policy, and that difference is declared here, per
 * channel, rather than spread across the callers.
 *
 * The session's state is injected, never imported: the browser's egress
 * worker thread judges against mirrored state (its own module instances have
 * empty registries), the main thread against the live registries. One
 * decision either way.
 *
 * Not yet here, on purpose (docs/proposals/egress-consolidation.md): the
 * destination-aware secret scan stays in the dispatch gate until a second
 * enforcement point judges bytes at send time, and the browser's first-party
 * exemption stays with the browser, since it is a rule about where a request
 * goes, not what it carries.
 */
import type { TaintSource } from "../data-lineage/index.js";

export type EgressChannel = "tool-dispatch" | "browser-page" | "tool-send" | "user-channel";

/**
 * How each channel reads the session's taint.
 *
 * - "floor": a session that read sensitive content is blocked from egress
 *   unless this payload is proven free of every tainted entry's complete
 *   content (data-lineage checkEgressTaintWithPayload). A tool call is one
 *   deliberate send, so an unprovable payload is refused and the user can
 *   declassify.
 * - "overlap": only a payload that actually carries tainted bytes is refused.
 *   A page makes hundreds of requests (CDN assets, analytics, its own API);
 *   the floor would stop every page from rendering after one sensitive read.
 *   The bytes a tool puts on the wire (tool-send) are judged the same way: the
 *   floor was already applied, at dispatch, to what the model wrote, so at
 *   send only evidence refuses — bytes the tool added that carry what was read.
 * - "none": taint does not refuse. The user's own channels (the phone, and a
 *   Telegram or WhatsApp chat the user talks to the agent in) show the user
 *   the chat the desktop shows, which has no taint check: an answer built from
 *   a file the user asked about is theirs to read anywhere. The canary and a
 *   secret-shaped value still refuse there (owner ruling 2026-11-20).
 */
export const EGRESS_CHANNEL_TAINT: Readonly<Record<EgressChannel, "floor" | "overlap" | "none">> = {
  "tool-dispatch": "floor",
  "browser-page": "overlap",
  "tool-send": "overlap",
  "user-channel": "none",
};

type TaintHit = { source: TaintSource; target: string };

/** What the browser channel needs of a session: canary and positive overlap. */
export interface PageEgressState {
  checkCanariesInPayload(sessionId: string, payload: string): string | null;
  findTaintInPayload(sessionId: string, payload: string): TaintHit[];
}

/** The tool channel additionally reads the taint floor. */
export interface DispatchEgressState extends PageEgressState {
  checkEgressTaintWithPayload(sessionId: string, payload: string): { blocked: boolean; reason?: string; evidence: TaintHit[] };
}

/** At send, a stored secret's value is evidence too: the bytes are what the
 *  tool built, so a value the model never wrote can be among them. The caller
 *  removes the values this call was approved to send before judging. */
export interface SendEgressState extends PageEgressState {
  containsKnownSecretValue(payload: string): boolean;
}

/** A user channel reads no taint; it is judged on the canary and on any
 *  secret-shaped value, since what reaches a phone or a chat app's servers
 *  leaves this machine. `null` from the shape scan: not judged (a binary
 *  payload that carries no text). */
export interface UserChannelEgressState {
  checkCanariesInPayload(sessionId: string, payload: string): string | null;
  containsSecretShape(payload: string): boolean | null;
}

export interface EgressJudgement {
  /** The session's canary is in the payload: proof of exfiltration. */
  canary: boolean;
  /** The payload is refused for taint, with the floor's reason when the
   *  channel reads the floor and the overlapping sources when there are any. */
  taint: { reason?: string; sources: TaintHit[] } | null;
  /** tool-send only: a stored secret's value the call was not approved to send. */
  knownSecret?: boolean;
  /** user-channel only: a secret-shaped value is in the payload. */
  secretShape?: boolean;
}

export function judgeEgress(state: DispatchEgressState, channel: "tool-dispatch", sessionId: string, payload: string): EgressJudgement;
export function judgeEgress(state: PageEgressState, channel: "browser-page", sessionId: string, payload: string): EgressJudgement;
export function judgeEgress(state: SendEgressState, channel: "tool-send", sessionId: string, payload: string): EgressJudgement;
export function judgeEgress(state: UserChannelEgressState, channel: "user-channel", sessionId: string, payload: string): EgressJudgement;
export function judgeEgress(state: PageEgressState | DispatchEgressState | SendEgressState | UserChannelEgressState, channel: EgressChannel, sessionId: string, payload: string): EgressJudgement {
  const canary = state.checkCanariesInPayload(sessionId, payload) !== null;
  if (channel === "user-channel") {
    return { canary, taint: null, secretShape: (state as UserChannelEgressState).containsSecretShape(payload) === true };
  }
  const knownSecret = channel === "tool-send" ? (state as SendEgressState).containsKnownSecretValue(payload) : undefined;
  let taint: EgressJudgement["taint"] = null;
  if (EGRESS_CHANNEL_TAINT[channel] === "floor") {
    const floor = (state as DispatchEgressState).checkEgressTaintWithPayload(sessionId, payload);
    if (floor.blocked) taint = { reason: floor.reason, sources: floor.evidence };
  } else {
    const sources = (state as PageEgressState).findTaintInPayload(sessionId, payload);
    if (sources.length > 0) taint = { sources };
  }
  return knownSecret === undefined ? { canary, taint } : { canary, taint, knownSecret };
}
