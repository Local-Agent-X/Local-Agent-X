import { describe, it, expect, beforeEach } from "vitest";
import {
  artifactRequestMiddleware,
  looksLikeUnobservableSymptomReport,
} from "./artifact-request.js";
import { makeCanonicalLoopContext } from "./ctx.test-helper.js";
import { clearMiddlewareStateForOp } from "./state.js";

const OP_ID = "op-artifact-request";

/** An interactive chat context at a given turn.
 *
 *  Note it sets `currentUserMessage` — the message that opened THIS op — and
 *  deliberately leaves `userMessage` empty. `userMessage` is the FIRST user row
 *  in op_messages, which on any op after a session's opening line is a STALE
 *  message (see current-user-message.test.ts, which pins that seam against a
 *  history-seeded op shape rather than a hand-passed string). If a refactor
 *  ever repoints this middleware back at `userMessage`, every test here goes
 *  red instead of silently passing on the wrong field. */
function ctxFor(currentUserMessage: string, turnIdx = 2, opId = OP_ID) {
  return makeCanonicalLoopContext({
    op: { id: opId, lane: "interactive", type: "chat_turn" },
    turnIdx,
    currentUserMessage,
  });
}

/** The reported-in-the-incident message: a visual defect the agent can only
 *  render at a viewport the user is not using. */
const MOBILE_BAR = "there is a grey bar above the nav bar on mobile";

function fire(ctx: ReturnType<typeof ctxFor>) {
  return artifactRequestMiddleware.beforeTurn!(ctx) as { kind: string; message?: string };
}

beforeEach(() => {
  clearMiddlewareStateForOp(OP_ID);
  clearMiddlewareStateForOp("op-other");
});

describe("artifact-request — firing", () => {
  it("nudges early when the user reports a symptom the agent cannot observe", () => {
    expect(fire(ctxFor(MOBILE_BAR)).kind).toBe("nudge");
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

  it("reads the message that opened THIS op, not the session's first message", () => {
    // The stale-field bug in one assertion: a context whose `userMessage` is the
    // qualifying report but whose CURRENT message is unrelated must stay silent.
    const stale = makeCanonicalLoopContext({
      op: { id: OP_ID, lane: "interactive", type: "chat_turn" },
      turnIdx: 2,
      userMessage: MOBILE_BAR,
      currentUserMessage: "thanks, that fixed it — what should we do next?",
    });
    expect(fire(stale).kind).toBe("continue");
  });
});

/**
 * The reviewer's 20 realistic probes. 13 of these disagreed with intent on the
 * first cut of the gate — every one of them is pinned here by shape, with the
 * suppressor that has to catch it named.
 */
describe("artifact-request — precision (reviewer probe set)", () => {
  const SILENT: Array<[string, string]> = [
    // Subjects the agent can RUN OR OPEN ITSELF. "on my machine" / "I see" /
    // "for me" does not make a test suite unobservable.
    ["agent-observable: unit test", "the unit test fails on my machine, npm test errors out"],
    ["agent-observable: typecheck", "tsc is broken on my machine, I see a type error"],
    ["agent-observable: CI", "deploy is broken, I see the CI job failing"],
    ["agent-observable: repo", "this doesn't work for me, can you look at the repo?"],
    ["agent-observable: repo path", "It looks like the retry logic is broken in src/x.ts"],
    ["agent-observable: stylesheet", "the nav looks broken on my phone — please fix the CSS"],
    ["agent-observable: test rerun", "run the tests again, they were failing for me earlier"],
    ["agent-observable: build", "the build is broken, npm run build fails with a type error"],
    // Build / regenerate requests — including the trailing forms an
    // `^`-anchored cue could not see.
    ["build request: trailing rebuild", "the login page looks wrong on mobile, rebuild it"],
    ["build request: leading", "build me a landing page with a nav bar that doesn't break on mobile"],
    ["build request: implement", "implement dark mode across the app and make sure nothing looks wrong"],
    // Relayed complaints — the user is a messenger and cannot produce the
    // artifact on request.
    ["relayed: customer email", "A customer emailed: “the checkout is broken on my phone”. Draft a reply."],
    ["relayed: bug report", "Summarise this bug report: users report the modal is cut off on mobile"],
    // No build verb anywhere in this one — the relayed cue is the ONLY
    // suppressor that can catch it, which is what makes it a mutation sentinel.
    ["relayed: forwarded complaint", "A customer emailed us — the checkout is broken on mobile and it shows up right after login"],
    // Evidence already supplied.
    ["supplied: screenshot", "the nav is broken on mobile, screenshot attached"],
    ["supplied: image", "it looks wrong on my phone — see the image"],
    ["supplied: file:line", "I keep getting an error on my machine at src/app/nav.tsx:42"],
    // The fence content deliberately carries no error-shaped line, so the
    // ``` branch is the only suppressor that can catch this one.
    ["supplied: fenced paste", "when I click submit it fails on mobile:\n```\nx is not a function\n```"],
    // …and this one is caught only by the timestamped-log-line branch, the
    // shape the first cut of the gate missed entirely.
    ["supplied: UNFENCED log paste", [
      "the page goes blank on my phone, here is what I got:",
      "2026-08-14T09:12:03Z checkout did not finish",
      "  retry scheduled after 3s",
    ].join("\n")],
  ];

  for (const [label, msg] of SILENT) {
    it(`stays silent — ${label}`, () => {
      expect(looksLikeUnobservableSymptomReport(msg), msg).toBe(false);
    });
  }

  const FIRES: Array<[string, string]> = [
    ["the incident verbatim", MOBILE_BAR],
    // The recall hole: the incident restated as an instruction. The first cut
    // reached the visual case only via a literal "there is/there's a …".
    ["the incident as an instruction", "fix the grey bar above the nav on mobile"],
    ["session-only symptom", "when I click save the page goes blank for me, it's been broken all week"],
    ["viewport-only symptom", "there's a weird gap under the header on my phone"],
  ];

  for (const [label, msg] of FIRES) {
    it(`fires — ${label}`, () => {
      expect(looksLikeUnobservableSymptomReport(msg), msg).toBe(true);
    });
  }
});

describe("artifact-request — the [2,6] window is a range, not a single turn", () => {
  it("does not fire before the early window opens", () => {
    expect(fire(ctxFor(MOBILE_BAR, 0)).kind).toBe("continue");
    expect(fire(ctxFor(MOBILE_BAR, 1)).kind).toBe("continue");
  });

  it("does not fire once the op is past the early window", () => {
    expect(fire(ctxFor(MOBILE_BAR, 7)).kind).toBe("continue");
    expect(fire(ctxFor(MOBILE_BAR, 40)).kind).toBe("continue");
  });

  // The load-bearing one. Five earlier beforeTurn middlewares can each nudge,
  // and host.ts short-circuits on the first non-continue — so turn 2 is
  // frequently PREEMPTED and this middleware is never invoked on it. Each turn
  // in the window therefore has to fire on its own, on a fresh op. Without
  // this, LAST_TURN could be lowered to 2 and the whole suite would stay green.
  for (const turn of [3, 4, 5, 6]) {
    it(`still fires at turn ${turn} when every earlier turn was preempted`, () => {
      const opId = `op-preempt-${turn}`;
      clearMiddlewareStateForOp(opId);
      expect(fire(ctxFor(MOBILE_BAR, turn, opId)).kind).toBe("nudge");
    });
  }

  it("fires at most once per op across the whole early window", () => {
    const kinds = [2, 3, 4, 5, 6].map((turn) => fire(ctxFor(MOBILE_BAR, turn)).kind);
    expect(kinds.filter((k) => k === "nudge")).toHaveLength(1);
    expect(kinds[0]).toBe("nudge");
  });

  it("keeps per-op state separate — a second op still gets its nudge", () => {
    expect(fire(ctxFor(MOBILE_BAR)).kind).toBe("nudge");
    expect(fire(ctxFor(MOBILE_BAR, 2, "op-other")).kind).toBe("nudge");
  });
});

describe("artifact-request — lanes", () => {
  function whenFor(lane: string, type: string) {
    return artifactRequestMiddleware.when!(makeCanonicalLoopContext({
      op: { id: OP_ID, lane, type },
      turnIdx: 2,
      currentUserMessage: MOBILE_BAR,
    }));
  }

  it("runs on chat", () => {
    expect(whenFor("interactive", "chat_turn")).toBe(true);
  });

  it("skips worker ops — nobody is there to answer", () => {
    expect(whenFor("agent", "agent_spawn")).toBe(false);
  });

  // voice_turn is lane:"interactive" too (voice-ws.ts:326). Every artifact the
  // nudge asks for — a screenshot, a screen recording, pasted console text — is
  // un-handoverable in a spoken conversation, and the nudge gets read aloud.
  it("skips voice — a spoken conversation cannot hand over a screenshot", () => {
    expect(whenFor("interactive", "voice_turn")).toBe(false);
  });
});

describe("artifact-request — input bounds", () => {
  it("ignores a message too terse to classify", () => {
    // Satisfies BOTH positive cues ("bug" + "mobile") and every suppressor:
    // the length floor is the only thing keeping it silent, so deleting
    // MIN_MESSAGE_LEN turns this red.
    expect(looksLikeUnobservableSymptomReport("bug mobile")).toBe(false);
  });

  it("treats a very long message as a paste — the evidence is already in hand", () => {
    const paste = `${MOBILE_BAR}\n${"a".repeat(5000)}`;
    expect(looksLikeUnobservableSymptomReport(paste)).toBe(false);
  });

  it("treats a many-line message as a paste", () => {
    expect(looksLikeUnobservableSymptomReport(`${MOBILE_BAR}\n${"line\n".repeat(20)}`)).toBe(false);
  });

  /**
   * Regression guard for a measured server-wide stall. The first cut had no
   * upper length bound and paired adjacent unbounded token classes
   * (`[\w-]+ ?[\w-]* (bar|gap|…)`); measured synchronously on the event loop it
   * ran 16.8s at 160KB and ~80s at 200KB, freezing every op on the box. Both
   * halves are fixed — the bound and the regex shape — so the budget here is
   * generous by three orders of magnitude and still catches a reintroduction.
   */
  it("is fast on a 200KB pathological input", () => {
    const kebab = "looks-wrong-on-my-phone-".repeat(9000); // ~216KB, no separators
    const inputs = [
      kebab,
      `looks wrong on my phone ${kebab}`,
      `there is a ${kebab} bar`,
      "x".repeat(200_000),
      `${"a-".repeat(100_000)} gap`,
    ];
    const t0 = performance.now();
    for (const input of inputs) looksLikeUnobservableSymptomReport(input);
    const elapsed = performance.now() - t0;
    expect(elapsed).toBeLessThan(50);
  });
});

describe("artifact-request — never escalates", () => {
  it("only ever returns nudge or continue", () => {
    for (const turn of [0, 2, 3, 9]) {
      expect(["nudge", "continue"]).toContain(fire(ctxFor(MOBILE_BAR, turn)).kind);
    }
  });
});
