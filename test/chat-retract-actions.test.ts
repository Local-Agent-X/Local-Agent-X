// @vitest-environment happy-dom
//
// Behavior contract for the last-turn recovery controls (public/js/
// chat-retract-actions.js): "Regenerate" and "Edit & resend". These let a user
// recover a polluted chat WITHOUT a new session, backed by POST /api/retract
// (mode:"turn"). The controls MUST be gated to the last turn and to
// NOT-streaming (a running turn would 409 on retract and re-route sendMessage
// to a mid-stream inject). Regenerate must retract → drop the local pair →
// re-send the same prompt; Edit & resend must retract → drop → repopulate the
// composer WITHOUT auto-sending.
import { describe, it, expect, beforeEach, vi } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));

interface Msg { role: string; content: string; attachments?: unknown }
interface Chat { id: string; messages: Msg[] }
type Ack = { ok: boolean; mode?: string; reason?: string };

interface RetractGlobals {
  appendLastTurnControls(footer: Element): void;
  regenerateLastTurn(): Promise<void>;
  editResendLastTurn(): Promise<void>;
  retractLastTurn(mode: string): Promise<Ack>;
}

// Bare globals the module reads (activeChat, apiPost, ChatStreamStore, …) are
// resolved against globalThis at call time, exactly as browser <script> globals.
const g = globalThis as unknown as {
  window: RetractGlobals & { sendMessage: ReturnType<typeof vi.fn> };
  document: Document;
  activeChat: Chat | null;
  apiPost: ReturnType<typeof vi.fn>;
  saveChats: ReturnType<typeof vi.fn>;
  renderMessages: ReturnType<typeof vi.fn>;
  ChatStreamStore: { isStreaming: (id: string) => boolean };
};

let mod: RetractGlobals;
let streaming = false;
let ackToReturn: Ack;

beforeEach(() => {
  document.body.innerHTML = '<textarea id="msg-input"></textarea>';
  streaming = false;
  ackToReturn = { ok: true, mode: "turn" };

  g.activeChat = {
    id: "s1",
    messages: [
      { role: "user", content: "compute 2+2" },
      { role: "assistant", content: "5 (oops)" },
    ],
  };
  g.apiPost = vi.fn(async () => ackToReturn);
  g.saveChats = vi.fn();
  g.renderMessages = vi.fn();
  g.ChatStreamStore = { isStreaming: () => streaming };
  g.window.sendMessage = vi.fn();

  const src = readFileSync(join(here, "../public/js/chat-retract-actions.js"), "utf8");
  // eslint-disable-next-line no-new-func
  new Function(src)();
  mod = g.window as unknown as RetractGlobals;
});

function footer(): HTMLElement {
  const f = document.createElement("div");
  f.className = "msg-footer";
  document.body.appendChild(f);
  return f;
}

describe("last-turn controls — rendering gate", () => {
  it("renders both controls on a completed (not-streaming) last turn", () => {
    const f = footer();
    mod.appendLastTurnControls(f);
    const bar = f.querySelector(".last-turn-actions");
    expect(bar).not.toBeNull();
    expect(bar!.querySelectorAll("button.last-turn-btn").length).toBe(2);
  });

  it("renders NOTHING while the session is streaming", () => {
    streaming = true;
    const f = footer();
    mod.appendLastTurnControls(f);
    expect(f.querySelector(".last-turn-actions")).toBeNull();
  });

  it("renders NOTHING when there is no user turn to act on", () => {
    g.activeChat!.messages = [{ role: "assistant", content: "hello" }];
    const f = footer();
    mod.appendLastTurnControls(f);
    expect(f.querySelector(".last-turn-actions")).toBeNull();
  });

  it("is idempotent — a second call does not duplicate the bar", () => {
    const f = footer();
    mod.appendLastTurnControls(f);
    mod.appendLastTurnControls(f);
    expect(f.querySelectorAll(".last-turn-actions").length).toBe(1);
  });
});

describe("regenerateLastTurn", () => {
  it("retracts the turn, drops the local pair, then re-sends the same prompt", async () => {
    await mod.regenerateLastTurn();
    expect(g.apiPost).toHaveBeenCalledWith("/api/retract", { sessionId: "s1", mode: "turn" });
    // last user + its response removed
    expect(g.activeChat!.messages.length).toBe(0);
    expect(g.saveChats).toHaveBeenCalled();
    expect(g.renderMessages).toHaveBeenCalled();
    const input = document.getElementById("msg-input") as HTMLTextAreaElement;
    expect(input.value).toBe("compute 2+2");
    expect(g.window.sendMessage).toHaveBeenCalledTimes(1);
  });

  it("does NOT drop or re-send when the retract is rejected (e.g. 409 turn-active)", async () => {
    ackToReturn = { ok: false, reason: "turn-active" };
    await mod.regenerateLastTurn();
    expect(g.activeChat!.messages.length).toBe(2); // untouched
    expect(g.window.sendMessage).not.toHaveBeenCalled();
  });

  it("does not retract while streaming (gated)", async () => {
    streaming = true;
    await mod.regenerateLastTurn();
    expect(g.apiPost).not.toHaveBeenCalled();
  });
});

describe("editResendLastTurn", () => {
  it("retracts, drops the pair, repopulates the composer, and does NOT auto-send", async () => {
    await mod.editResendLastTurn();
    expect(g.apiPost).toHaveBeenCalledWith("/api/retract", { sessionId: "s1", mode: "turn" });
    expect(g.activeChat!.messages.length).toBe(0);
    const input = document.getElementById("msg-input") as HTMLTextAreaElement;
    expect(input.value).toBe("compute 2+2");
    expect(g.window.sendMessage).not.toHaveBeenCalled();
  });

  it("strips the attachments prefix from the restored display text", async () => {
    g.activeChat!.messages = [
      { role: "user", content: "Attached files:\n/tmp/a.png\n\nwhat is this", attachments: [{ name: "a.png" }] },
      { role: "assistant", content: "an image" },
    ];
    await mod.editResendLastTurn();
    const input = document.getElementById("msg-input") as HTMLTextAreaElement;
    expect(input.value).toBe("what is this");
  });
});
