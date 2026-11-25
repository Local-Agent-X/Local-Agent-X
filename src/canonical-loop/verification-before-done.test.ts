/**
 * The figures check before "done" (checkFiguresBeforeDone, the completion
 * chain's figures-verify gate). It used to run a minute after the reply, so a
 * deck could be emailed before a check corrected it (2026-11-24). Now a turn
 * that built a deliverable from outside figures holds its "done" until they
 * are checked, bounded so it can never wait forever on a verifier that needs
 * the slot or local model the turn itself holds.
 */
import { describe, it, expect, afterAll, afterEach, beforeEach } from "vitest";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const prevLaxDir = process.env.LAX_DATA_DIR;
const laxDir = realpathSync(mkdtempSync(join(tmpdir(), "lax-verify-before-done-")));
process.env.LAX_DATA_DIR = laxDir;
mkdirSync(join(laxDir, "sessions"), { recursive: true });
afterAll(() => {
  if (prevLaxDir === undefined) delete process.env.LAX_DATA_DIR;
  else process.env.LAX_DATA_DIR = prevLaxDir;
  rmSync(laxDir, { recursive: true, force: true });
});

const { checkFiguresBeforeDone, checkFiguresOnRequest, deliverablesToCheck, _setVerificationSubmitterForTests, _resetVerificationTriggerForTests, VERIFICATION_OP_TYPE } = await import("./verification-trigger.js");
const { checkBeforeDone, armVerificationDebounce, changedDeliverables, VERIFICATION_DEBOUNCE_MS } = await import("./verification-spend.js");
const { figureCheckUpdate, figureCheckOf, _resetFigureCheckNotesForTests } = await import("./figure-check-note.js");
const { REVIEW_PUBLISH_OP_TYPE } = await import("./publish-review-verdict.js");
const { OP_TYPE } = await import("../ops/op-types.js");
const { readOp, writeOp } = await import("../ops/op-store.js");
const { trackOpForSession, releaseOpFromSession } = await import("../ops/session-bridge.js");
const { recordExternalIngestion, clearExternalIngestion } = await import("../data-lineage/external.js");
const { recordTaskArtifact, clearTaskArtifacts } = await import("../data-lineage/task-artifacts.js");
const { readReplyNotes } = await import("../memory/reply-notes.js");
const { getRuntimeConfig, setRuntimeConfig } = await import("../config.js");

let seq = 0;
const ops: string[] = [];
const sessions: string[] = [];
let work: string;
let submitted: Array<{ sessionId: string; deliverables: string[]; scope?: string }>;

function session(): string {
  const id = `sess-before-done-${seq++}`;
  sessions.push(id);
  return id;
}

function op(type: string, sessionId: string) {
  const id = `op_before_done_${type}_${seq++}`;
  writeOp({ id, type, status: "running", task: `task ${id}` } as never);
  trackOpForSession(id, sessionId, `task ${id}`);
  ops.push(id);
  return readOp(id)!;
}

/** A session that read the web and wrote a deck. */
function deckSession(): { sessionId: string; deck: string } {
  const sessionId = session();
  const deck = join(work, `deck-${seq++}.pptx`);
  writeFileSync(deck, "slides");
  recordExternalIngestion(sessionId, "https://example.com/market-report", "web_fetch");
  recordTaskArtifact(sessionId, deck);
  return { sessionId, deck };
}

beforeEach(() => {
  work = realpathSync(mkdtempSync(join(tmpdir(), "lax-before-done-work-")));
  _resetVerificationTriggerForTests();
  _resetFigureCheckNotesForTests();
  submitted = [];
  _setVerificationSubmitterForTests(async (input) => { submitted.push({ sessionId: input.sessionId, deliverables: input.deliverables, ...(input.scope ? { scope: input.scope } : {}) }); return true; });
  setRuntimeConfig({ ...getRuntimeConfig(), verifyDeliverables: true });
});

afterEach(() => {
  _setVerificationSubmitterForTests(null);
  for (const id of ops.splice(0)) releaseOpFromSession(id);
  for (const s of sessions.splice(0)) { clearExternalIngestion(s); clearTaskArtifacts(s); }
  rmSync(work, { recursive: true, force: true });
});

describe("a turn that built a deck from outside figures", () => {
  it("does not finish until the check's result lands, a correction included", async () => {
    const { sessionId, deck } = deckSession();
    const turn = op("chat_turn", sessionId);
    let finished = false;
    const done = checkFiguresBeforeDone(turn).then((r) => { finished = true; return r; });
    await new Promise((r) => setTimeout(r, 20));
    expect(submitted).toEqual([{ sessionId, deliverables: [deck] }]);
    expect(figureCheckOf(deck)).toBe("checking");
    figureCheckUpdate(sessionId, "correcting", 2);
    await new Promise((r) => setTimeout(r, 20));
    expect(finished).toBe(false);
    figureCheckUpdate(sessionId, "corrected", 2);
    expect(await done).toBe("checked");
    // The note belongs to the reply that ends this turn, and says what changed.
    const [note] = readReplyNotes(join(laxDir, "sessions"), sessionId);
    expect(note).toEqual(expect.objectContaining({ on: "next", status: "corrected", text: expect.stringMatching(/^Corrected 2 figures in deck-\d+\.pptx to match their sources\.$/) }));
  });

  it("is checked once: the turn's own ending then finds nothing new", async () => {
    const { sessionId } = deckSession();
    const turn = op("chat_turn", sessionId);
    const done = checkFiguresBeforeDone(turn);
    await new Promise((r) => setTimeout(r, 20));
    figureCheckUpdate(sessionId, "confirmed");
    await done;
    expect(deliverablesToCheck(turn, sessionId, { includeCorrection: true })).toBeNull();
  });

  it("takes over a check already waiting for the chat to go quiet, and covers its files", async () => {
    const { sessionId, deck } = deckSession();
    const earlier = join(work, "sheet.xlsx");
    writeFileSync(earlier, "cells");
    const turn = op("chat_turn", sessionId);
    armVerificationDebounce(sessionId, turn, new Map(), [earlier]);
    const { current, delta } = changedDeliverables(sessionId, [deck]);
    const done = checkBeforeDone(sessionId, turn, current, delta, { timeoutMs: 1_000 });
    await new Promise((r) => setTimeout(r, 20));
    figureCheckUpdate(sessionId, "confirmed");
    await done;
    expect(submitted).toHaveLength(1);
    expect(submitted[0].deliverables.sort()).toEqual([deck, earlier].sort());
    // The quiet period it replaced never fires a second check.
    await new Promise((r) => setTimeout(r, Math.min(VERIFICATION_DEBOUNCE_MS, 50)));
    expect(submitted).toHaveLength(1);
  });

  it("stops waiting after its bound, and the check lands on the reply later", async () => {
    const { sessionId, deck } = deckSession();
    const turn = op("chat_turn", sessionId);
    const { current, delta } = changedDeliverables(sessionId, [deck]);
    expect(await checkBeforeDone(sessionId, turn, current, delta, { timeoutMs: 30 })).toBe("timed-out");
    figureCheckUpdate(sessionId, "confirmed");
    expect(readReplyNotes(join(laxDir, "sessions"), sessionId)[0].status).toBe("confirmed");
  });

  it("finishes at once, saying the figures were not checked, when no verifier can start", async () => {
    const { sessionId } = deckSession();
    _setVerificationSubmitterForTests(async () => false);
    expect(await checkFiguresBeforeDone(op("chat_turn", sessionId))).toBe("not-submitted");
    expect(readReplyNotes(join(laxDir, "sessions"), sessionId)[0].status).toBe("unchecked");
  });

  it("a stopped turn stops waiting", async () => {
    const { sessionId } = deckSession();
    const stop = new AbortController();
    const done = checkFiguresBeforeDone(op("chat_turn", sessionId), stop.signal);
    await new Promise((r) => setTimeout(r, 20));
    stop.abort();
    expect(await done).toBe("timed-out");
  });
});

describe("what is never held", () => {
  it.each([
    ["the verifier", VERIFICATION_OP_TYPE],
    ["the pre-publish review", REVIEW_PUBLISH_OP_TYPE],
    ["the correction", OP_TYPE.correctDeliverable],
  ])("%s's own ending", async (_name, type) => {
    const { sessionId } = deckSession();
    expect(await checkFiguresBeforeDone(op(type, sessionId))).toBe("skipped");
    expect(submitted).toEqual([]);
  });

  it("a turn in a session that read nothing from outside", async () => {
    const sessionId = session();
    const deck = join(work, "local.pptx");
    writeFileSync(deck, "slides");
    recordTaskArtifact(sessionId, deck);
    expect(await checkFiguresBeforeDone(op("chat_turn", sessionId))).toBe("skipped");
  });

  it("a turn whose session wrote no deliverable", async () => {
    const sessionId = session();
    recordExternalIngestion(sessionId, "https://example.com", "web_fetch");
    expect(await checkFiguresBeforeDone(op("chat_turn", sessionId))).toBe("skipped");
  });
});

describe("a check the user asked for (figures_check)", () => {
  it("checks the named file with the scope asked for, waits, and reports the note", async () => {
    const { sessionId, deck } = deckSession();
    const turn = op("chat_turn", sessionId);
    const done = checkFiguresOnRequest(turn, [deck], "all");
    await new Promise((r) => setTimeout(r, 20));
    expect(submitted).toEqual([{ sessionId, deliverables: [deck], scope: "all" }]);
    figureCheckUpdate(sessionId, "confirmed", 0, { checked: 40, total: 40 });
    expect(await done).toEqual({ result: "checked", note: expect.stringMatching(/^Checked all 40 figures in deck-\d+\.pptx/) });
    // The turn's own ending finds the file already checked.
    expect(deliverablesToCheck(turn, sessionId)).toBeNull();
  });

  it("says so when the setting is off, and checks nothing", async () => {
    const { sessionId, deck } = deckSession();
    setRuntimeConfig({ ...getRuntimeConfig(), verifyDeliverables: false });
    expect(await checkFiguresOnRequest(op("chat_turn", sessionId), [deck], "rest")).toEqual({ result: "off", note: null });
    expect(submitted).toEqual([]);
  });

  it("does not start a second check while one is running", async () => {
    const { sessionId, deck } = deckSession();
    op(VERIFICATION_OP_TYPE, sessionId);
    expect((await checkFiguresOnRequest(op("chat_turn", sessionId), [deck], "rest")).result).toBe("busy");
  });
});
