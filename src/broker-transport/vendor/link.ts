// The peer link the desktop and the phone build after the broker introduces them.
// The desktop is the offerer: it creates every data channel below on one persistent
// peer, and the phone dispatches on the label. Voice is a second peer from its own
// rendezvous (`?channel=voice`) and carries only the `voice` channel.

/** Data-channel labels. A label is part of the wire: renaming one strands every
 *  installed build that dispatches on the old name. */
export const DATA_CHANNEL = {
  /** Live-screen control: remote input and screen open/close up, display hints down (control.ts). */
  control: "control",
  /** The desktop's chat protocol (chat.ts). */
  chat: "chat",
  /** Device REST tunneled to the desktop's loopback server (tunnel.ts). */
  http: "http",
  /** Desktop-only projection surface; the phone does not open it. */
  projection: "projection",
  /** Voice control plane, on the voice peer (voice.ts). */
  voice: "voice",
} as const;

export type DataChannelLabel = (typeof DATA_CHANNEL)[keyof typeof DATA_CHANNEL];

/** How long a client waits after `peer-present` for the broker's `ice-servers` frame
 *  before building its peer without it. A TURN-less broker never sends the frame, so
 *  neither side may wait forever; the broker's first mint after a restart was measured
 *  at ~3.2 s (and timers under load fire up to ~1 s late), and a peer built without
 *  STUN/TURN only connects on the same network. Both apps wait this one window, so
 *  neither gives up on the relay sooner than the other. */
export const ICE_GRACE_MS = 8000;
