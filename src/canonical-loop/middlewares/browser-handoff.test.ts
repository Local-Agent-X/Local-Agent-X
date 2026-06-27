import { describe, it, expect, vi } from "vitest";
import type { CanonicalLoopContext } from "./types.js";
import { browserHandoffMiddleware, opGaveUpUnrecovered } from "./browser-handoff.js";
import { classifyGaveUp } from "../../classifiers/give-up-classify.js";
import { recordGaveUpNudge } from "../../tool-tracker.js";

vi.mock("../../classifiers/give-up-classify.js", () => ({
  classifyGaveUp: vi.fn(async () => null),
}));
vi.mock("../../tool-tracker.js", () => ({
  recordGaveUpNudge: vi.fn(),
  classifyOpCategory: vi.fn(() => "browser"),
}));

const mockClassify = classifyGaveUp as unknown as ReturnType<typeof vi.fn>;
const mockRecord = recordGaveUpNudge as unknown as ReturnType<typeof vi.fn>;

let opCounter = 0;
function ctx(over: Partial<CanonicalLoopContext> = {}): CanonicalLoopContext {
  const toolsCalledThisOp = over.toolsCalledThisOp ?? new Set(["browser"]);
  return {
    op: { id: `op-${opCounter++}`, type: "chat_turn", lane: "interactive" },
    turnIdx: 1,
    toolCalls: [],
    toolsCalledThisOp,
    // Defaults to the ok-only set; the crash-then-punt test overrides it to
    // exercise a drive tool that was attempted but never succeeded.
    attemptedToolsThisOp: over.attemptedToolsThisOp ?? toolsCalledThisOp,
    userMessage: "open the page and tell me the headline",
    assistantContent: "Dismiss it yourself or give me a Cloudflare API token.",
    ...over,
  } as unknown as CanonicalLoopContext;
}

const fire = (c: CanonicalLoopContext) => browserHandoffMiddleware.afterModelCall!(c);

describe("browser-handoff gate", () => {
  it("only applies to chat_turn ops", () => {
    expect(browserHandoffMiddleware.when!(ctx())).toBe(true);
    expect(browserHandoffMiddleware.when!(ctx({ op: { id: "v", type: "voice_turn" } as never }))).toBe(false);
    expect(browserHandoffMiddleware.when!(ctx({ op: { id: "w", type: "agent_spawn" } as never }))).toBe(false);
  });

  it("nudges when a browser turn ends by punting the obstruction back to the user", async () => {
    const res = await fire(ctx());
    expect(res.kind).toBe("nudge");
    if (res.kind === "nudge") {
      expect(res.reason).toBe("browser-handoff");
      expect(res.message).toMatch(/evaluate/);
    }
  });

  it("continues when the turn still requested tools", async () => {
    expect((await fire(ctx({ toolCalls: [{} as never] }))).kind).toBe("continue");
  });

  it("continues when no drive or research tool was used this op", async () => {
    expect((await fire(ctx({ toolsCalledThisOp: new Set(["bash"]) }))).kind).toBe("continue");
  });

  it("continues on a genuine completion (no hand-off phrasing)", async () => {
    expect(
      (await fire(ctx({ assistantContent: "Both sites are open in separate tabs." }))).kind,
    ).toBe("continue");
  });

  it("continues on a real credential ask the model already tried to resolve", async () => {
    // 'unable' / 'blocked' phrasing still nudges once — that's intended; the
    // nudge itself preserves genuine credential asks. Here we assert a plain
    // status line does NOT trip it.
    expect(
      (await fire(ctx({ assistantContent: "Added the DNS record. The site is now active." }))).kind,
    ).toBe("continue");
  });

  it("fires at most once per op", async () => {
    const c = ctx();
    expect((await fire(c)).kind).toBe("nudge");
    expect((await fire(c)).kind).toBe("continue");
  });

  it("recognizes the 'want me to keep driving or switch to the API' punt", async () => {
    const res = await fire(
      ctx({ assistantContent: "The consent banner is still blocking the page. Want me to keep driving, or switch to the API token route?" }),
    );
    expect(res.kind).toBe("nudge");
  });

  it("fires on a give-up the regex misses when the classifier flags it", async () => {
    mockClassify.mockResolvedValueOnce(true);
    const res = await fire(
      ctx({ assistantContent: "I wasn't able to pull the headline from the page." }),
    );
    expect(res.kind).toBe("nudge");
  });

  it("does NOT fire when the classifier says the task completed, even if the regex would", async () => {
    mockClassify.mockResolvedValueOnce(false);
    // The default assistantContent matches HANDOFF_PATTERNS, so the regex alone
    // would fire — the model verdict overrides it toward NOT nudging.
    expect((await fire(ctx())).kind).toBe("continue");
  });

  it("falls back to the regex on null and continues when it doesn't match", async () => {
    mockClassify.mockResolvedValueOnce(null);
    expect(
      (await fire(ctx({ assistantContent: "Both sites are open in separate tabs." }))).kind,
    ).toBe("continue");
  });

  it("records the give-up nudge in durable telemetry when it fires", async () => {
    mockRecord.mockClear();
    mockClassify.mockResolvedValueOnce(true);
    const res = await fire(ctx({ assistantContent: "I'm blocked by the overlay." }));
    expect(res.kind).toBe("nudge");
    expect(mockRecord).toHaveBeenCalledTimes(1);
    expect(mockRecord.mock.calls[0][0]).toBe("browser");
  });

  it("does NOT record a nudge when the turn completes cleanly", async () => {
    mockRecord.mockClear();
    mockClassify.mockResolvedValueOnce(false);
    await fire(ctx({ assistantContent: "Both sites are open in separate tabs." }));
    expect(mockRecord).not.toHaveBeenCalled();
  });

  it("fires when the drive tool only FAILED (browser crashed, then the model punted)", async () => {
    // The crash keeps `browser` out of the ok-only toolsCalledThisOp; the gate
    // must still fire off attemptedToolsThisOp. This is the sweep's Task-A miss.
    mockClassify.mockResolvedValueOnce(true);
    const res = await fire(ctx({
      toolsCalledThisOp: new Set(),
      attemptedToolsThisOp: new Set(["browser"]),
      assistantContent: "Browser tool is crashing on the page. Want me to try web_fetch instead?",
    }));
    expect(res.kind).toBe("nudge");
  });

  it("persists the give-up verdict so the terminal label can demote it to partial", async () => {
    mockClassify.mockResolvedValueOnce(true);
    const c = ctx({ assistantContent: "I'm blocked by the overlay." });
    await fire(c);
    expect(opGaveUpUnrecovered(c.op.id)).toBe(true);
  });

  it("clears the give-up verdict when a later turn delivers (recovery stays clean)", async () => {
    const c = ctx();
    mockClassify.mockResolvedValueOnce(true);
    await fire(c);                       // turn N: gives up → nudge, verdict true
    expect(opGaveUpUnrecovered(c.op.id)).toBe(true);
    mockClassify.mockResolvedValueOnce(false);
    await fire({ ...c, assistantContent: "The headline is: Markets rally." });  // turn N+1: delivered
    expect(opGaveUpUnrecovered(c.op.id)).toBe(false);
  });

  it("leaves the verdict false for an op the gate never evaluated", async () => {
    const c = ctx({ toolsCalledThisOp: new Set(["bash"]) });
    await fire(c);                       // neither drive nor research → gate skips
    expect(opGaveUpUnrecovered(c.op.id)).toBe(false);
  });

  it("labels a research give-up but does NOT nudge (no open page to keep driving)", async () => {
    mockClassify.mockResolvedValueOnce(true);
    const c = ctx({
      toolsCalledThisOp: new Set(["web_fetch"]),
      attemptedToolsThisOp: new Set(["web_fetch", "web_search"]),
      assistantContent: "I couldn't pull the Reuters headline — every fetch 404'd and search only surfaces the homepage.",
    });
    const res = await fire(c);
    expect(res.kind).toBe("continue");                 // research = label-only, no nudge
    expect(opGaveUpUnrecovered(c.op.id)).toBe(true);   // but the verdict IS stored for the label
  });

  it("does not store a give-up for a research op that delivered", async () => {
    mockClassify.mockResolvedValueOnce(false);
    const c = ctx({
      toolsCalledThisOp: new Set(["web_fetch"]),
      attemptedToolsThisOp: new Set(["web_fetch"]),
      assistantContent: "Reuters' top headline is: \"Markets rally on rate-cut hopes\".",
    });
    expect((await fire(c)).kind).toBe("continue");
    expect(opGaveUpUnrecovered(c.op.id)).toBe(false);
  });

  it("regex backstop catches the 'Blocked … Which way?' option-menu punt (the Guardian give-up)", async () => {
    // Production case 2026-06-26: Grok punted on the Guardian Sourcepoint wall
    // with this exact shape; the classifier timed out (null) and the old regex
    // matched none of it, so the turn was allowed to stop.
    mockClassify.mockResolvedValueOnce(null);
    const res = await fire(ctx({
      assistantContent:
        "Blocked: Guardian's persistent Sourcepoint consent overlay cannot be dismissed by the browser tools.\n\n" +
        "Options:\n1. Switch to web_fetch.\n2. Use a different news site.\n3. Tell me to stop.\n\nWhich way?",
    }));
    expect(res.kind).toBe("nudge");
  });
});
