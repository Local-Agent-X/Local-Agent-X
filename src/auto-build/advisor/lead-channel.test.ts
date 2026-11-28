// A lead that drives its build from its own turn: build_next waits inside the
// turn and returns what the build has, so the lead decides where it read the
// evidence. Four days of builds (2026-11-24 to 27) had the lead answer 7 of 28
// decisions, each asked in a turn of its own.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { setChatHandler } from "../../chat-ws/chat-handler.js";
import { acquireTurn, releaseTurn } from "../../session/turn-lock.js";
import { _resetInjectQueues, pushInject } from "../../agent-loop/inject-queue.js";
import { askLead, type LeadSituation } from "./lead-decisions.js";
import { buildDecideTool } from "./build-decide-tool.js";
import { buildNextTool, buildNextResult } from "../orchestrator/build-next-tool.js";
import { isMutationTool } from "../../tool-mutation-check.js";
import { isCommittingTool } from "../../committing-tool-check.js";
import { getToolTimeout } from "../../tool-execution/tool-timeout.js";
import { _resetLeadChannels, leadCheckpoint, leadIsAttached, postToLead, takeForLead, type LeadWait } from "./lead-channel.js";

const CHAT = "chat-lead";
const ref = { projectDir: "C:/ws/apps/shop-helper", originSessionId: CHAT };
const situation: LeadSituation = {
  chunk: { number: 2, title: "Price list", slice: "s", doneWhen: "prices load", scenarios: "none" },
  totalChunks: 4, round: 1, finding: "The skeptic broke it: an empty list throws.", workerReport: "STATUS: done",
  earlier: [], repeated: false, maxRounds: 8,
};
const running: LeadWait = { stillRunning: () => true, userIsWaiting: () => false, pollMs: 5 };
const tick = (ms = 20) => new Promise((r) => setTimeout(r, ms));

let posted: string[];
beforeEach(() => {
  posted = [];
  _resetLeadChannels();
  _resetInjectQueues();
  setChatHandler(async (_sessionId, message) => { posted.push(message); });
});
afterEach(() => releaseTurn(CHAT));

describe("a lead waiting in build_next", () => {
  it("is handed a decision as the call's result, answers it there, and no message is posted", async () => {
    acquireTurn(CHAT, new AbortController());
    const call = takeForLead(CHAT, running);
    const asked = askLead(ref, situation, { answerMs: 5_000 });
    const { why, items } = await call;
    expect(why).toBe("items");
    expect(items).toHaveLength(1);
    expect(items[0].text).toContain("an empty list throws");
    // The lead goes on with the build, and the app-message header is not there.
    expect(items[0].text).toContain("then build_next again");
    expect(items[0].text).not.toContain("Sent by the app");
    const id = items[0].id!;
    await buildDecideTool.execute({ decision_id: id, action: "continue", reasoning: "real", instruction: "guard the empty list" }, undefined as never);
    expect(await asked).toMatchObject({ action: "continue", instruction: "guard the empty list" });
    releaseTurn(CHAT);
    await tick();
    expect(posted).toEqual([]);
  });

  it("gets the decision posted into the chat when its turn ends with it still open", async () => {
    acquireTurn(CHAT, new AbortController());
    const call = takeForLead(CHAT, running);
    const asked = askLead(ref, situation, { answerMs: 5_000 });
    const { items } = await call;
    releaseTurn(CHAT);
    await tick();
    expect(posted).toHaveLength(1);
    expect(posted[0]).toContain("(Sent by the app, not typed by the user");
    expect(posted[0]).toContain(`decision_id="${items[0].id}"`);
    await buildDecideTool.execute({ decision_id: items[0].id, action: "accept", reasoning: "holds" }, undefined as never);
    expect(await asked).toMatchObject({ action: "accept" });
  });

  it("is not handed a decision the chat was already sent as a message", async () => {
    const asked = askLead(ref, situation, { answerMs: 5_000 });
    await tick();
    expect(posted).toHaveLength(1);
    expect((await takeForLead(CHAT, { ...running, stillRunning: () => false })).why).toBe("not-running");
    const id = posted[0].match(/decision_id="([^"]+)"/)![1];
    await buildDecideTool.execute({ decision_id: id, action: "accept", reasoning: "holds" }, undefined as never);
    await asked;
  });

  it("stops waiting when the user writes, when Stop is pressed, and when no build is running", async () => {
    acquireTurn(CHAT, new AbortController());
    let userWrote = false;
    const forUser = takeForLead(CHAT, { ...running, userIsWaiting: () => userWrote });
    userWrote = true;
    expect((await forUser).why).toBe("user-message");

    const stop = new AbortController();
    const stopped = takeForLead(CHAT, { ...running, pollMs: 60_000, signal: stop.signal });
    stop.abort();
    expect((await stopped).why).toBe("stopped");

    expect((await takeForLead(CHAT, { ...running, stillRunning: () => false })).why).toBe("not-running");
    // What it had is read before any of those.
    postToLead(CHAT, { kind: "ended", text: "The build finished." });
    expect((await takeForLead(CHAT, { ...running, stillRunning: () => false })).items[0].text).toBe("The build finished.");
  });
});

describe("a batch boundary", () => {
  it("holds the build for an attached lead until it calls build_next again", async () => {
    acquireTurn(CHAT, new AbortController());
    await takeForLead(CHAT, { ...running, stillRunning: () => false });
    expect(leadIsAttached(CHAT)).toBe(true);
    let goneOn = false;
    void leadCheckpoint(CHAT, "Chunks 1 and 2 landed.", { waitMs: 5_000 }).then(() => { goneOn = true; });
    const first = await takeForLead(CHAT, running);
    expect(first.items.map((i) => i.text)).toEqual(["Chunks 1 and 2 landed."]);
    await tick();
    expect(goneOn).toBe(false);
    const next = takeForLead(CHAT, { ...running, stillRunning: () => false });
    await tick();
    expect(goneOn).toBe(true);
    await next;
  });

  it("lets the build go on when the lead's turn ends, and never holds it for a lead that is not attached", async () => {
    let goneOn = false;
    await leadCheckpoint(CHAT, "Chunk 1 landed.", { waitMs: 5_000 });

    acquireTurn(CHAT, new AbortController());
    expect((await takeForLead(CHAT, running)).items).toHaveLength(1);
    void leadCheckpoint(CHAT, "Chunk 2 landed.", { waitMs: 5_000 }).then(() => { goneOn = true; });
    await tick();
    expect(goneOn).toBe(false);
    releaseTurn(CHAT);
    await tick();
    expect(goneOn).toBe(true);
    expect(leadIsAttached(CHAT)).toBe(false);
  });
});

describe("the build's end", () => {
  it("falls back to waking the chat when the lead's turn ends without reading it", async () => {
    acquireTurn(CHAT, new AbortController());
    await takeForLead(CHAT, { ...running, stillRunning: () => false });
    let woken = 0;
    postToLead(CHAT, { kind: "ended", text: "The build finished.", undelivered: () => { woken++; } });
    releaseTurn(CHAT);
    expect(woken).toBe(1);
  });
});

describe("build_next", () => {
  // A turn that calls it again and again is leading a build, not spinning: the
  // guards that end a turn for making no progress count it as work, and the
  // harness never abandons a call for running long.
  it("counts as work to the loop guards and has no time limit of its own", () => {
    expect(isMutationTool("build_next")).toBe(true);
    expect(isCommittingTool("build_next")).toBe(true);
    expect(getToolTimeout("build_next")).toBe(0);
  });

  it("returns what the build had and says what to call next", async () => {
    expect(buildNextResult("items", [{ kind: "decision", id: "bd-1", text: "Decision bd-1: ..." }])).toContain("Answer each decision with build_decide, then call build_next again.");
    expect(buildNextResult("items", [{ kind: "batch", text: "Chunk 1 landed." }])).toContain("The build waits here for you");
    expect(buildNextResult("items", [{ kind: "ended", text: "The build finished." }])).toBe("The build finished.");
    expect(buildNextResult("user-message", [])).toContain("Answer it, then call build_next again");
  });

  it("returns at once for a chat with no build running, and when the user has written", async () => {
    const none = await buildNextTool.execute({ _sessionId: CHAT }, undefined as never);
    expect(String(none.content)).toContain("No build this chat leads is running");
    pushInject(CHAT, "how is it going?");
    const wrote = await buildNextTool.execute({ _sessionId: CHAT }, undefined as never);
    expect(String(wrote.content)).toContain("The user sent a message");
  });
});
