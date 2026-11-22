// `/approve` typed in the desktop chat: the chat socket gives the turn no
// sink, so the confirmation and the turn's end went nowhere and the chat
// waited forever, and the agent, which had said it was waiting on this
// approval, was never told (2026-11-22).
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ServerEvent } from "../../../types.js";

vi.mock("../../../threat/consent-store.js", () => ({ grantConsent: vi.fn(), getLastBlockedFingerprint: vi.fn(() => null) }));
vi.mock("../../../threat/canaries.js", () => ({ recoverSessionBreach: vi.fn(() => false) }));
const sent = vi.hoisted(() => [] as Array<{ sessionId: string; text: string | null }>);
vi.mock("../../../chat-ws/app-message.js", () => ({
  isUserChat: (id: string) => !id.startsWith("cron-"),
  sendAppMessageWhenIdle: (sessionId: string, compose: () => string | null) => { sent.push({ sessionId, text: compose() }); return true; },
}));

const { approvedRetryMessage, handleApproveCommand, handleApproveInTurn } = await import("./slash-interceptors.js");
const { grantConsent } = await import("../../../threat/consent-store.js");

afterEach(() => { vi.clearAllMocks(); sent.length = 0; });

describe("/approve", () => {
  it("grants consent, ends the turn on the transport it was given, and wakes the agent to retry", async () => {
    const events: ServerEvent[] = [];
    const woken: string[] = [];
    const result = await handleApproveCommand(
      "/approve downloading the preview APK from expo.dev", "chat-1",
      (e) => { events.push(e); }, (m) => { woken.push(m); },
    );

    expect(result.handled).toBe(true);
    expect(grantConsent).toHaveBeenCalledWith("chat-1", 30 * 60_000, "downloading the preview APK from expo.dev");
    expect(events.map((e) => e.type)).toEqual(["stream", "done"]);
    expect((events[0] as { delta: string }).delta).toContain("The agent is retrying the blocked step now.");
    expect(woken).toEqual([approvedRetryMessage("downloading the preview APK from expo.dev")]);
    // The app's own message, drawn as a note (public/js/chat-app-message.js).
    expect(woken[0].split("\n")[0]).toContain("Sent by the app, not typed by the user");
  });

  it("without an agent to wake, says how to have it retry", async () => {
    const events: ServerEvent[] = [];
    await handleApproveCommand("/approve", "chat-2", (e) => { events.push(e); });
    expect((events[0] as { delta: string }).delta).toContain("Type the original request again or ask the agent to retry.");
    expect(events.at(-1)?.type).toBe("done");
  });

  describe("from a chat turn", () => {
    it("on the chat socket (no sink), replies to the chat and the agent is sent the retry", async () => {
      const toChat: ServerEvent[] = [];
      await handleApproveInTurn("/approve the download", "chat-4", { sseSink: null, channel: "web", emitToChat: (e) => { toChat.push(e); } });
      expect(toChat.map((e) => e.type)).toEqual(["stream", "done"]);
      expect(sent).toEqual([{ sessionId: "chat-4", text: approvedRetryMessage("the download") }]);
    });

    it("on the HTTP route, replies on its sink, not the chat socket", async () => {
      const onSink: ServerEvent[] = [];
      const toChat = vi.fn();
      await handleApproveInTurn("/approve x", "chat-5", { sseSink: (e) => { onSink.push(e); }, channel: "web", emitToChat: toChat });
      expect(onSink.map((e) => e.type)).toEqual(["stream", "done"]);
      expect(toChat).not.toHaveBeenCalled();
    });

    it("does not wake an agent on another channel or in a background session", async () => {
      await handleApproveInTurn("/approve x", "chat-6", { sseSink: null, channel: "telegram", emitToChat: () => {} });
      await handleApproveInTurn("/approve x", "cron-7", { sseSink: null, channel: "web", emitToChat: () => {} });
      expect(sent).toEqual([]);
    });
  });

  it("leaves any other message alone", async () => {
    const emit = vi.fn();
    expect(await handleApproveCommand("approve the plan", "chat-3", emit)).toEqual({ handled: false });
    expect(emit).not.toHaveBeenCalled();
    expect(grantConsent).not.toHaveBeenCalled();
  });
});
