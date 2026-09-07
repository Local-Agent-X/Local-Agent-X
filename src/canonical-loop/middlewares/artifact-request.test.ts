import { describe, it, expect, beforeEach } from "vitest";
import { artifactRequestMiddleware } from "./artifact-request.js";
import { makeCanonicalLoopContext } from "./ctx.test-helper.js";
import { clearMiddlewareStateForOp } from "./state.js";

const OP_ID = "op-artifact-request";

/** An interactive-lane context at a given turn with a given user message —
 *  the only two inputs this gate reads besides the lane. */
function ctxFor(userMessage: string, turnIdx = 2, opId = OP_ID) {
  return makeCanonicalLoopContext({
    op: { id: opId, lane: "interactive", type: "chat_turn" },
    turnIdx,
    userMessage,
  });
}

/** The reported-in-the-incident message: a visual defect the agent can only
 *  render at a viewport the user is not using. */
const MOBILE_BAR = "there is a grey bar above the nav bar on mobile";

function fire(ctx: ReturnType<typeof ctxFor>) {
  return artifactRequestMiddleware.beforeTurn!(ctx) as { kind: string; message?: string };
}

describe("artifact-request", () => {
  beforeEach(() => {
    clearMiddlewareStateForOp(OP_ID);
    clearMiddlewareStateForOp("op-other");
  });

  it("nudges early when the user reports a symptom the agent cannot observe", () => {
    const r = fire(ctxFor(MOBILE_BAR));
    expect(r.kind).toBe("nudge");
  });

  it("names concrete artifacts to request and legitimises asking as a complete outcome", () => {
    const r = fire(ctxFor(MOBILE_BAR));
    expect(r.message).toMatch(/screenshot/i);
    expect(r.message).toMatch(/device|browser|viewport/i);
    expect(r.message).toMatch(/complete outcome/i);
  });

  it("nudges on a user-session symptom the agent has no access to", () => {
    const r = fire(ctxFor("when I click save the page goes blank for me, it's been broken all week"));
    expect(r.kind).toBe("nudge");
  });

  it("stays silent on a build request that merely mentions defects", () => {
    const r = fire(ctxFor("build me a landing page with a nav bar that doesn't break on mobile"));
    expect(r.kind).toBe("continue");
  });

  it("stays silent on a research/implement request", () => {
    const r = fire(ctxFor("implement dark mode across the app and make sure nothing looks wrong"));
    expect(r.kind).toBe("continue");
  });

  it("stays silent on a symptom the agent can observe itself", () => {
    const r = fire(ctxFor("the build is broken, npm run build fails with a type error"));
    expect(r.kind).toBe("continue");
  });

  it("stays silent when the user already supplied the artifact", () => {
    for (const msg of [
      "the nav is broken on mobile, screenshot attached",
      "it looks wrong on my phone — see the image",
      "I keep getting an error on my machine at src/app/nav.tsx:42",
      "when I click submit it fails on mobile:\n```\nTypeError: x is not a function\n```",
    ]) {
      expect(fire(ctxFor(msg)).kind, msg).toBe("continue");
    }
  });

  it("does not fire before the early window opens", () => {
    expect(fire(ctxFor(MOBILE_BAR, 0)).kind).toBe("continue");
    expect(fire(ctxFor(MOBILE_BAR, 1)).kind).toBe("continue");
  });

  it("does not fire once the op is past the early window — asking late is the failure it prevents", () => {
    expect(fire(ctxFor(MOBILE_BAR, 7)).kind).toBe("continue");
    expect(fire(ctxFor(MOBILE_BAR, 40)).kind).toBe("continue");
  });

  it("fires at most once per op across the whole early window", () => {
    const kinds = [2, 3, 4, 5, 6].map((turn) => fire(ctxFor(MOBILE_BAR, turn)).kind);
    expect(kinds.filter((k) => k === "nudge")).toHaveLength(1);
    expect(kinds[0]).toBe("nudge");
  });

  it("keeps per-op state separate — a second op still gets its nudge", () => {
    expect(fire(ctxFor(MOBILE_BAR)).kind).toBe("nudge");
    expect(fire(ctxFor(MOBILE_BAR, 2, "op-other")).kind).toBe("nudge");
  });

  it("runs on interactive lanes only — a worker op has nobody to ask", () => {
    const interactive = ctxFor(MOBILE_BAR);
    const worker = makeCanonicalLoopContext({
      op: { id: OP_ID, lane: "agent", type: "agent_spawn" },
      turnIdx: 2,
      userMessage: MOBILE_BAR,
    });
    expect(artifactRequestMiddleware.when!(interactive)).toBe(true);
    expect(artifactRequestMiddleware.when!(worker)).toBe(false);
  });

  it("never aborts or suspends", () => {
    for (const turn of [0, 2, 3, 9]) {
      expect(["nudge", "continue"]).toContain(fire(ctxFor(MOBILE_BAR, turn)).kind);
    }
  });
});
