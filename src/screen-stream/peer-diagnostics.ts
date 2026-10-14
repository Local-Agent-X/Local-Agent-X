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
  // werift reports "checking" then "completed" on its own while gathering, before
  // the answer arrives; only ICE states after the peer starts connecting describe
  // a connection attempt.
  let attempting = false;
  let stuckTimer: ReturnType<typeof setInterval> | null = null;
  const stopStuckProbe = () => {
    if (stuckTimer) clearInterval(stuckTimer);
    stuckTimer = null;
  };
  pc.iceConnectionStateChange.subscribe((state) => {
    if (!attempting && state !== "closed") return;
    const msg = `[rtc ${label}] ICE ${state} (phone offered: ${tally(remote)}; desktop: ${tally(local)})`;
    if (state === "failed" || state === "disconnected") logger.warn(msg);
    else logger.info(msg);
  });
  pc.connectionStateChange.subscribe((state) => {
    logger.info(`[rtc ${label}] peer ${state}`);
    // ICE "connected" fires before werift nominates a pair; once the peer itself
    // is connected (DTLS up) the route is settled.
    if (state === "connected") logSelectedRoute(pc, label);
    if (state === "connecting" && !attempting) {
      attempting = true;
      // A connection that never comes up logs nothing else, so report what the
      // checks are doing while it hangs.
      let elapsed = 0;
      stuckTimer = setInterval(() => {
        elapsed += STUCK_PROBE_MS / 1000;
        if (elapsed >= STUCK_PROBE_MS * STUCK_PROBE_LIMIT / 1000) stopStuckProbe();
        logStuckChecks(pc, label, elapsed, tally(remote));
      }, STUCK_PROBE_MS);
      stuckTimer.unref?.();
    }
    if (state !== "connecting") stopStuckProbe();
  });

  return {
    noteRemoteCandidate: (candidate) => bump(remote, candidateType(candidate)),
  };
}

/** One ICE check as the agent holds it: candidate types and state, no addresses. */
export interface PairView {
  local: string;
  remote: string;
  state: number;
  nominated: boolean;
}

/** werift's live check list. Its getStats() keys candidate pairs by foundation,
 *  so distinct pairs overwrite each other and report stale states; the ICE
 *  connection's own list is the source of truth. */
function checkList(pc: WeriftPeerConnection): PairView[] {
  return pc.iceTransports.flatMap((t) =>
    t.connection.checkList.map((p) => ({
      local: p.localCandidate.type,
      remote: p.remoteCandidate.type,
      state: p.state,
      nominated: p.nominated,
    })),
  );
}

/** Log which route ICE settled on (host / srflx / relay on each side). */
function logSelectedRoute(pc: WeriftPeerConnection, label: string): void {
  try {
    const pair = pc.iceTransports.map((t) => t.connection.nominated).find((p) => p !== undefined);
    if (!pair) {
      logger.info(`[rtc ${label}] connected; no nominated candidate pair yet`);
      return;
    }
    logger.info(`[rtc ${label}] route: desktop ${pair.localCandidate.type} ↔ phone ${pair.remoteCandidate.type}`);
  } catch (e) {
    logger.warn(`[rtc ${label}] could not read the selected route: ${(e as Error).message}`);
  }
}

const STUCK_PROBE_MS = 10_000;
const STUCK_PROBE_LIMIT = 3;

/** werift's CandidatePairState enum, by value. */
const PAIR_STATES = ["frozen", "waiting", "in-progress", "succeeded", "failed"];

/** Summarize ICE checks as "desktop→phone state ×count" groups, e.g.
 *  "relay→srflx failed ×2; host→host succeeded ×1". Types and counts only. */
export function summarizePairs(pairs: readonly PairView[]): string {
  const groups = new Map<string, number>();
  for (const p of pairs) {
    const key = `${p.local}→${p.remote} ${PAIR_STATES[p.state] ?? String(p.state)}${p.nominated ? " (nominated)" : ""}`;
    groups.set(key, (groups.get(key) ?? 0) + 1);
  }
  if (groups.size === 0) return "no candidate pairs";
  return [...groups.entries()].map(([k, n]) => `${k} ×${n}`).join("; ");
}

function logStuckChecks(pc: WeriftPeerConnection, label: string, seconds: number, phoneOffered: string): void {
  try {
    logger.warn(`[rtc ${label}] still connecting after ${seconds}s; phone routes received: ${phoneOffered}; checks: ${summarizePairs(checkList(pc))}`);
  } catch (e) {
    logger.warn(`[rtc ${label}] still connecting after ${seconds}s; could not read checks: ${(e as Error).message}`);
  }
}

/** Log a named data channel opening or closing (chat, apps, control). */
export function logChannelState(label: string, channel: string, state: string): void {
  if (state === "open" || state === "closed") logger.info(`[rtc ${label}] channel ${channel} ${state}`);
}
