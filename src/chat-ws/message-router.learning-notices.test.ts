/**
 * A learned-workflow notice is broadcast when the post-turn review proposes a
 * draft — often while nobody has that chat open. The subscribe snapshot is
 * what re-delivers the ones still waiting on the user.
 */
import { describe, it, expect } from "vitest";
import type { WebSocket } from "ws";

const { attachMessageRouter } = await import("./message-router.js");
const { setLearningNoticesForSession } = await import("./state.js");

function subscribe(sessionId: string): Promise<Array<Record<string, unknown>>> {
  const sent: string[] = [];
  let onMessage: ((data: Buffer) => unknown) | null = null;
  const ws = {
    readyState: 1,
    send: (frame: string) => { sent.push(frame); },
    on: (evt: string, cb: (data: Buffer) => unknown) => { if (evt === "message") onMessage = cb; },
  } as unknown as WebSocket;
  attachMessageRouter({ ws, subscriptions: new Set<string>() });
  return Promise.resolve(onMessage!(Buffer.from(JSON.stringify({ type: "subscribe", sessionId }))))
    .then(() => sent.map((frame) => JSON.parse(frame) as Record<string, unknown>));
}

describe("session_snapshot carries pending learning notices", () => {
  it("includes the notices pending for the subscribed session", async () => {
    const notice = { id: "learned-0123456789abcdefabcd", versionId: "v", name: "po_flow" };
    setLearningNoticesForSession((sessionId) => (sessionId === "chat-1" ? [notice] : []));

    const snapshot = (await subscribe("chat-1")).find((f) => f.type === "session_snapshot");
    expect(snapshot).toMatchObject({ sessionId: "chat-1", learningNotices: [notice] });

    const other = (await subscribe("chat-2")).find((f) => f.type === "session_snapshot");
    expect(other).toMatchObject({ sessionId: "chat-2", learningNotices: [] });
  });
});
