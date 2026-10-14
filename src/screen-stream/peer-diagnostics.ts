// Connection diagnostics for the desktop's broker peer — the one link chat, the
// phone's app list and the live screen all ride. Field report 2026-10-13: after
// the phone left Wi-Fi, the broker relayed a complete offer/answer with relay
// candidates on both sides, and then nothing — the desktop log stopped at "relay
// servers received" with no word on whether ICE ever connected, over which
// route, or whether the chat channel reopened. These lines answer exactly that.
//
// Logs candidate TYPES, states and route kinds only — never an address, port,
// username or credential.

import type { RTCPeerConnection as WeriftPeerConnection } from "werift";
import { createLogger } from "../logger.js";

const logger = createLogger("screen-stream.rtc");

type CandidateType = "host" | "srflx" | "prflx" | "relay" | "unknown";

/** The `typ` of an ICE candidate line ("candidate:… typ relay raddr …"). */
export function candidateType(candidate: string | undefined | null): CandidateType {
  const m = /\btyp\s+(host|srflx|prflx|relay)\b/.exec(candidate ?? "");
  return (m?.[1] as CandidateType | undefined) ?? "unknown";
}

function tally(counts: Map<CandidateType, number>): string {
  if (counts.size === 0) return "none";
  return [...counts.entries()].map(([type, n]) => `${type} ${n}`).join(", ");
}

/** The TURN URL werift will actually use: it takes only the FIRST `turn:` entry
 *  (utils.parseIceServers) and speaks UDP to it whatever its `transport=`. */
export function weriftTurnUrl(urls: readonly string[]): string | null {
  return urls.find((u) => u.includes("turn:")) ?? null;
}

export interface PeerDiagnostics {
  /** Record a candidate the phone trickled. */
  noteRemoteCandidate(candidate: string): void;
}

/** Attach the logging to a fresh peer. `label` tells peers apart in the log. */
export function watchPeerDiagnostics(
  pc: WeriftPeerConnection,
  label: string,
  iceUrls: readonly string[],
): PeerDiagnostics {
  const local = new Map<CandidateType, number>();
  const remote = new Map<CandidateType, number>();
  const bump = (m: Map<CandidateType, number>, t: CandidateType) => m.set(t, (m.get(t) ?? 0) + 1);

  const turn = weriftTurnUrl(iceUrls);
  logger.info(
    `[rtc ${label}] peer created: ${iceUrls.length} ICE url(s); relay via ${turn ? turn.replace(/^(turns?:)([^:?]+)/, "$1<host>") : "NONE — direct only, fails off the LAN"}`,
  );

  pc.onIceCandidate.subscribe((c) => {
    if (c?.candidate) bump(local, candidateType(c.candidate));
  });
  pc.iceGatheringStateChange.subscribe((state) => {
    if (state !== "complete") return;
    const relayMissing = turn && !local.get("relay");
    const msg = `[rtc ${label}] desktop gathered: ${tally(local)}`;
    if (relayMissing) logger.warn(`${msg} — TURN gave no relay candidate (allocation failed or UDP to the relay is blocked, e.g. by a VPN)`);
    else logger.info(msg);
  });
  // werift reports "completed" once on its own before checks begin; only states
  // after checking describe a connection attempt.
  let checking = false;
  pc.iceConnectionStateChange.subscribe((state) => {
    if (state === "checking") checking = true;
    if (!checking && (state === "completed" || state === "connected")) return;
    const msg = `[rtc ${label}] ICE ${state} (phone offered: ${tally(remote)}; desktop: ${tally(local)})`;
    if (state === "failed" || state === "disconnected") logger.warn(msg);
    else logger.info(msg);
    if (state === "connected" || state === "completed") void logSelectedRoute(pc, label);
  });
  pc.connectionStateChange.subscribe((state) => {
    logger.info(`[rtc ${label}] peer ${state}`);
  });

  return {
    noteRemoteCandidate: (candidate) => bump(remote, candidateType(candidate)),
  };
}

/** Log which route ICE settled on (host / srflx / relay on each side). */
async function logSelectedRoute(pc: WeriftPeerConnection, label: string): Promise<void> {
  try {
    const report = await pc.getStats();
    const stats = [...report.values()] as unknown as Array<Record<string, unknown>>;
    const pairs = stats.filter((s) => s.type === "candidate-pair");
    // werift reports pair state as a numeric enum; the nominated pair is the route.
    const pair = pairs.find((p) => p.nominated);
    if (!pair) {
      logger.info(`[rtc ${label}] connected; no nominated candidate pair in stats yet`);
      return;
    }
    const byId = new Map(stats.map((s) => [s.id as string, s]));
    const l = byId.get(pair.localCandidateId as string);
    const r = byId.get(pair.remoteCandidateId as string);
    const relayProto = l?.relayProtocol ? ` (${String(l.relayProtocol)})` : "";
    logger.info(`[rtc ${label}] route: desktop ${String(l?.candidateType ?? "?")}${relayProto} ↔ phone ${String(r?.candidateType ?? "?")}`);
  } catch (e) {
    logger.warn(`[rtc ${label}] could not read the selected route: ${(e as Error).message}`);
  }
}

/** Log a named data channel opening or closing (chat, apps, control). */
export function logChannelState(label: string, channel: string, state: string): void {
  if (state === "open" || state === "closed") logger.info(`[rtc ${label}] channel ${channel} ${state}`);
}
