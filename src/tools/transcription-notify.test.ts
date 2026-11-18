// A long recording is left to its background job and the chat is woken when it
// ends, like a finished background op: the completion is queued for the
// agent's next turn and a turn is started to read it, so the agent is not tied
// up in its own turn calling transcribe_media for minutes.
import { describe, it, expect, vi, beforeEach } from "vitest";

const queued = vi.hoisted(() => [] as Array<Record<string, unknown>>);
const woken = vi.hoisted(() => [] as Array<{ sessionId: string; op: Record<string, unknown>; heardElsewhere: boolean }>);
vi.mock("../ops/pending-notifications.js", () => ({ pushPendingNotification: (_s: string, n: Record<string, unknown>) => queued.push(n) }));
vi.mock("../ops/op-report-wake.js", () => ({
  announceEndedOp: (sessionId: string, op: Record<string, unknown>, heardElsewhere: boolean) => woken.push({ sessionId, op, heardElsewhere }),
}));

const { announceTranscription, transcriptionNotice } = await import("./transcription-notify.js");
const { formatNotificationsForSystemPrompt } = await vi.importActual<typeof import("../ops/pending-notifications.js")>("../ops/pending-notifications.js");

const PATH = "C:\\Users\\me\\Downloads\\talk.mp4";
const done = { segments: [], coveredTo: 1809, complete: true, running: false };

beforeEach(() => { queued.length = 0; woken.length = 0; });

describe("transcriptionNotice", () => {
  it("tells the agent the transcript is ready and the call that reads it back at once", () => {
    const n = transcriptionNotice(PATH, 0, done);
    expect(n.status).toBe("completed");
    expect(n.summary).toBe("The transcript of talk.mp4 is ready (to 30:09).");
    expect(n.next).toContain(`transcribe_media(path=${JSON.stringify(PATH)}, start_at=0)`);
  });

  it("says where a failed job stopped and that calling again resumes it", () => {
    const n = transcriptionNotice(PATH, 0, { segments: [], coveredTo: 754, complete: false, running: false, error: "ffmpeg exited with code 1" });
    expect(n.status).toBe("failed");
    expect(n.summary).toBe("Transcribing talk.mp4 stopped at 12:34 (ffmpeg exited with code 1).");
    expect(n.next).toContain("start_at=754");
  });
});

describe("announceTranscription", () => {
  it("queues the completion and wakes the chat", () => {
    announceTranscription("chat-1", "transcribe:x", PATH, 0, done);
    expect(queued[0]).toMatchObject({ opId: "transcribe:x", status: "completed", task: "Transcribing talk.mp4", toolJob: { next: expect.stringContaining("transcribe_media") } });
    expect(woken[0]).toEqual({ sessionId: "chat-1", op: { opId: "transcribe:x", task: "Transcribing talk.mp4", status: "completed" }, heardElsewhere: false });
  });

  it("is rendered with its next step, never as an op to look up with op_status", () => {
    announceTranscription("chat-1", "transcribe:x", PATH, 0, done);
    const block = formatNotificationsForSystemPrompt(queued as never);
    expect(block).toContain("Transcribing talk.mp4: completed. The transcript of talk.mp4 is ready");
    expect(block).toContain("Next: call transcribe_media(");
    expect(block).not.toContain("op_status");
  });
});
