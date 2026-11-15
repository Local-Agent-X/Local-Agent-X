// The Greg/Vic case end to end: plans made in different chats, on different
// days, are caught as a clash; the same plan twice is one event.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadCalendar } from "./local-store.js";
import { recordPlan } from "./plans.js";
import { noticePlansInTurn } from "./notice.js";
import { registerCalendarSource } from "./index.js";
import { mentionsTime, extractPlansWithLLM } from "../classifiers/plan-extract.js";

const prev = process.env.LAX_DATA_DIR;
let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "lax-plans-")); process.env.LAX_DATA_DIR = dir; });
afterEach(() => {
  if (prev === undefined) delete process.env.LAX_DATA_DIR; else process.env.LAX_DATA_DIR = prev;
  rmSync(dir, { recursive: true, force: true });
});

const now = () => new Date("2026-11-14T10:00:00");

describe("plans LAX notices", () => {
  it("records a plan in LAX's calendar with where it came from, and the same plan again is one event", async () => {
    const first = await recordPlan({ title: "Greg", start: "2026-11-14T17:00:00", origin: { kind: "chat", ref: "s1" } }, { now });
    expect(first.recorded?.origin).toMatchObject({ kind: "chat", ref: "s1" });
    expect(first.recorded?.end).toBe(new Date(Date.parse("2026-11-14T17:00:00") + 60 * 60_000).toISOString());
    const again = await recordPlan({ title: "greg", start: "2026-11-14T17:00:00", origin: { kind: "chat", ref: "s9" } }, { now });
    expect(again.recorded).toBeNull();
    expect((await loadCalendar()).events).toHaveLength(1);
  });

  it("finds a clash with a plan from another chat, and with a connected calendar", async () => {
    await recordPlan({ title: "Greg", start: "2026-11-14T17:00:00", origin: { kind: "chat", ref: "chat-yesterday" } }, { now });
    const off = registerCalendarSource({
      id: "google:me", kind: "google", label: "Work",
      listEvents: async () => [{ id: "g1", title: "Standup", start: "2026-11-14T17:30:00", end: "2026-11-14T17:45:00", sourceId: "google:me" }],
    });
    try {
      const vic = await recordPlan({ title: "Vic", start: "2026-11-14T17:00:00", origin: { kind: "chat", ref: "chat-today" } }, { now });
      expect(vic.recorded).not.toBeNull();
      expect(vic.clashes.map((c) => c.title).sort()).toEqual(["Greg", "Standup"]);
    } finally { off(); }
  });

  it("ignores past plans and times that do not parse", async () => {
    expect((await recordPlan({ title: "x", start: "2026-11-13T09:00:00", origin: { kind: "chat", ref: "s" } }, { now })).recorded).toBeNull();
    expect((await recordPlan({ title: "x", start: "soon", origin: { kind: "chat", ref: "s" } }, { now })).recorded).toBeNull();
  });
});

describe("noticing plans after a turn", () => {
  const extract = (plans: Array<{ what: string; start: string; evidence: string }>) =>
    vi.fn(async () => plans.map((p) => ({ ...p, end: null, where: null, who: null })));

  it("records what the exchange settled and raises a clash", async () => {
    await recordPlan({ title: "Greg", start: "2026-11-14T17:00:00", origin: { kind: "chat", ref: "a" } }, { now });
    const announce = vi.fn();
    const n = await noticePlansInTurn(
      { userMessage: "tell Vic 5:00 works", assistantResponse: "Sent.", sessionId: "b" },
      { now, extract: extract([{ what: "Vic", start: "2026-11-14T17:00:00", evidence: "Vic 5:00 works" }]), announce },
    );
    expect(n).toBe(1);
    expect(announce).toHaveBeenCalledWith(expect.objectContaining({ title: "Vic" }), expect.arrayContaining([expect.objectContaining({ title: "Greg" })]), { kind: "chat", ref: "b" });
  });

  it("after reading outside content, only plans in the user's own words count", async () => {
    const record = vi.fn(async () => ({ recorded: null, clashes: [] }));
    await noticePlansInTurn(
      { userMessage: "summarize that page", assistantResponse: "It says the meeting is Friday at 3pm.", sessionId: "c", hasExternalTaint: true },
      { now, extract: extract([{ what: "Meeting", start: "2026-11-20T15:00:00", evidence: "Friday at 3pm" }]), record },
    );
    expect(record).not.toHaveBeenCalled();
  });

  it("never runs for internal sessions", async () => {
    const ex = extract([]);
    await noticePlansInTurn({ userMessage: "at 5", assistantResponse: "", sessionId: "mail-watch-1" }, { now, extract: ex });
    expect(ex).not.toHaveBeenCalled();
  });
});

describe("plan extraction", () => {
  it("skips the model when nothing mentions a time", async () => {
    expect(mentionsTime("thanks, looks good")).toBe(false);
    expect(mentionsTime("see you at 5pm")).toBe(true);
    expect(mentionsTime("Friday works")).toBe(true);
    const llm = vi.fn();
    expect(await extractPlansWithLLM({ userMessage: "thanks", now: now() }, { _llm: llm })).toEqual([]);
    expect(llm).not.toHaveBeenCalled();
  });

  it("keeps only plans with a verbatim span from the exchange and a time that parses", async () => {
    const llm = vi.fn(async () => JSON.stringify({ plans: [
      { what: "Dinner with Greg", start: "2026-11-14T17:00:00", evidence: "5:00 with Greg works" },
      { what: "Invented", start: "2026-11-14T18:00:00", evidence: "never said this" },
      { what: "Bad time", start: "later", evidence: "5:00 with Greg works" },
    ] }));
    const plans = await extractPlansWithLLM({ userMessage: "5:00 with Greg works", now: now() }, { _llm: llm });
    expect(plans.map((p) => p.what)).toEqual(["Dinner with Greg"]);
  });
});
