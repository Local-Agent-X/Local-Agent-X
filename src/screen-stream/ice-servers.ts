// The ICE server list a desktop werift peer is given, from the broker-minted (or
// operator) config. Shared by the screen/chat peer and the voice peer.
//
// werift writes the offer only after every TURN allocation settles, and a UDP
// allocation that is never answered settles only when its 7 retransmissions
// run out, 6.4 s later. Some paths drop UDP to a relay for particular source
// ports, every time: on 2026-11-19, 8 of 30 fresh ports never reached
// Cloudflare's TURN address over UDP while its STUN address, Google's STUN and
// 30 of 30 TCP and TLS connections to the same relay answered (60 / 135 ms).
// One phone connection in three waited 6-12 s before the desktop's offer left.
// So when the server also offers TURN over TCP or TLS, the desktop takes that
// and leaves the UDP address out: its relay candidate is the last-resort route,
// and a TCP leg to the relay costs nothing to gather.

import type { IceServerConfig } from "./peer.js";

/** One werift RTCIceServer: werift takes a single url per entry. */
export interface WeriftIceServer { urls: string; username?: string; credential?: string }

/** The transport a `turn:` / `turns:` url uses ("udp" for `turn:` without one). */
function turnTransport(url: string): "udp" | "tcp" | null {
  const lower = url.toLowerCase();
  if (lower.startsWith("turns:")) return "tcp";
  if (!lower.startsWith("turn:")) return null;
  return /[?&]transport=tcp\b/.test(lower) ? "tcp" : "udp";
}

/** Expand the configs (urls may be an array, standard/broker shape) into werift's
 *  one-url-per-entry form, without UDP TURN when TURN over TCP or TLS is offered.
 *  Drops absent username/credential so STUN entries don't carry empty TURN creds. */
export function weriftIceServers(servers: readonly IceServerConfig[]): WeriftIceServer[] {
  const entries = servers.flatMap((s) => (Array.isArray(s.urls) ? s.urls : [s.urls]).map((u) => {
    const entry: WeriftIceServer = { urls: u };
    if (s.username !== undefined) entry.username = s.username;
    if (s.credential !== undefined) entry.credential = s.credential;
    return entry;
  }));
  const tcpTurn = entries.some((e) => turnTransport(e.urls) === "tcp");
  return tcpTurn ? entries.filter((e) => turnTransport(e.urls) !== "udp") : entries;
}
