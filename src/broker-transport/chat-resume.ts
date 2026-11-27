// What the phone holds open on the desktop's chat socket, so the bridge can put it
// back on a new socket when the loopback drops (the server ends every chat socket
// after 24 h, or a heartbeat misses) while the data channel stays up. The phone
// sees no new link in that case, so it would never re-subscribe on its own and
// every live chat event, inbox change and worker event would stop reaching it.
//
// Per chat, the op of the last `done` the phone received rides along on the
// re-subscribe, so the desktop's replay skips a finished turn the phone already
// shows (chat-ws/replay.ts). A turn still running replays from its wipe, as on
// any reconnect.

/** List requests whose answer is a whole snapshot: asked again on a new socket. */
const SNAPSHOT_REQUESTS = new Set(["inbox_list", "workers_list"]);

type Frame = { type?: unknown; sessionId?: unknown; doneOpId?: unknown; event?: { type?: unknown; opId?: unknown } };

function parse(text: string): Frame | null {
  try {
    const frame = JSON.parse(text) as unknown;
    return typeof frame === "object" && frame !== null ? (frame as Frame) : null;
  } catch {
    return null;
  }
}

export class ChatResume {
  /** Subscribed chats → the op of the last `done` the phone received in each. */
  private readonly chats = new Map<string, string | undefined>();
  private readonly snapshots = new Set<string>();

  /** A frame the phone sent to the desktop. */
  fromPhone(text: string): void {
    const frame = parse(text);
    if (!frame || typeof frame.type !== "string") return;
    if (SNAPSHOT_REQUESTS.has(frame.type)) { this.snapshots.add(frame.type); return; }
    const sessionId = typeof frame.sessionId === "string" ? frame.sessionId : null;
    if (sessionId === null) return;
    // Sending a message subscribes the socket too (chat-ws/message-router.ts).
    if (frame.type === "subscribe" || frame.type === "chat") {
      const held = typeof frame.doneOpId === "string" ? frame.doneOpId : this.chats.get(sessionId);
      this.chats.set(sessionId, held);
    } else if (frame.type === "unsubscribe") {
      this.chats.delete(sessionId);
    }
  }

  /** A frame the desktop sent to the phone. Only a chat's `done` is read. */
  fromDesktop(text: string): void {
    if (!text.includes('"done"')) return; // the hot path: stream deltas never parse
    const frame = parse(text);
    if (frame?.type !== "event" || typeof frame.sessionId !== "string") return;
    if (frame.event?.type !== "done" || typeof frame.event.opId !== "string") return;
    if (this.chats.has(frame.sessionId)) this.chats.set(frame.sessionId, frame.event.opId);
  }

  /** A frame the restore already carries (a subscribe, a snapshot request): one the
   *  phone sent while the loopback was down is not sent a second time. */
  restores(text: string): boolean {
    const type = parse(text)?.type;
    return type === "subscribe" || (typeof type === "string" && SNAPSHOT_REQUESTS.has(type));
  }

  /** The frames that put the phone's subscriptions back on a new socket. */
  restoreFrames(): string[] {
    const out: string[] = [];
    for (const [sessionId, doneOpId] of this.chats) {
      out.push(JSON.stringify(doneOpId === undefined ? { type: "subscribe", sessionId } : { type: "subscribe", sessionId, doneOpId }));
    }
    for (const type of this.snapshots) out.push(JSON.stringify({ type }));
    return out;
  }
}
