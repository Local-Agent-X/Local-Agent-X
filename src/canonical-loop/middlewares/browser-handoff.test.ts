import { describe, it, expect } from "vitest";
import type { CanonicalLoopContext } from "./types.js";
import { browserHandoffMiddleware } from "./browser-handoff.js";

let opCounter = 0;
function ctx(over: Partial<CanonicalLoopContext> = {}): CanonicalLoopContext {
  return {
    op: { id: `op-${opCounter++}`, type: "chat_turn", lane: "interactive" },
    turnIdx: 1,
    toolCalls: [],
    toolsCalledThisOp: new Set(["browser"]),
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

  it("continues when no browser/computer tool was used this op", async () => {
    expect((await fire(ctx({ toolsCalledThisOp: new Set(["web_fetch"]) }))).kind).toBe("continue");
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
});
