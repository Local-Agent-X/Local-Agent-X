import { describe, it, expect, afterEach, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describeWhen, excerptAround, excerptNote, localDate } from "./retrieval-format.js";
import { readPastMessage } from "./tools/search/past-message.js";
import { memoryRecallTool } from "./tools/search/memory-recall.js";
import { searchPastSessionsTool } from "./tools/search/search-past-sessions.js";

vi.mock("./tools/search/app-matcher.js", () => ({ findMatchingApps: async () => [] }));
import type { MemoryIndex } from "./index.js";

// What a search hit tells the model must be what is true: which part of a
// message it shows, when that was said, and how to read the rest. On
// 2026-10-05 a hit carrying the user's quote showed only the first 500
// characters (the quote sat at 1985), read as a miss, and the agent called a
// true fact invented; on 2026-10-07 a hit dated by its chat's start made a
// same-morning message look two days old.
describe("excerptAround — the snippet shows the match, and says it was cut", () => {
  const summary = "## Key Exchanges ".padEnd(1985, "x") + 'a text from her sister that said "Did you fuck him yet"' + " y".repeat(180);

  it("centres on the query's match deep in a long chunk, marks both cuts, and reports the window", () => {
    const e = excerptAround(summary, "sister text", 500);
    expect(e.snippet).toContain("Did you fuck him yet");
    expect(e.snippet.startsWith("…")).toBe(true);
    expect(e.window).toMatchObject({ total: summary.length });
    expect(e.window!.end - e.window!.start).toBe(500);
  });

  it("returns a short chunk whole, with no window", () => {
    expect(excerptAround("short text", "text", 500)).toEqual({ snippet: "short text" });
  });

  it("with no query match, shows the start and still marks the cut", () => {
    const e = excerptAround(summary, "unrelated words", 500);
    expect(e.snippet.endsWith("…")).toBe(true);
    expect(e.window).toMatchObject({ start: 0, end: 500 });
  });

  it("the excerpt note names the window and the message to read in full", () => {
    expect(excerptNote({ snippetWindow: { start: 1700, end: 2200, total: 2374 }, provenance: { message_ids: ["um-op_1-init-a"] } as never }))
      .toBe('\n[excerpt: characters 1700–2200 of 2374; full text: search_past_sessions message_id="um-op_1-init-a"]');
    expect(excerptNote({})).toBe("");
  });
});

describe("describeWhen — a hit is dated by when it was said", () => {
  it("exact local time when known; the chat's start, flagged, when not; the stored day otherwise", () => {
    expect(describeWhen({ datetime: "2026-10-07T17:28:16.608Z", date: "2026-10-07" })).toMatch(/^2026-10-0[67] \d\d:\d\d local$/);
    expect(describeWhen({ date: "2026-10-05", date_approx: true })).toBe("2026-10-05 (chat start; exact time unknown)");
    expect(describeWhen({ date: "2026-10-05" })).toBe("2026-10-05");
    expect(describeWhen(undefined)).toBeUndefined();
  });
});

describe("readPastMessage — read a prior message in full by its id", () => {
  let dir: string;
  afterEach(() => rmSync(dir, { recursive: true, force: true }));
  function setup() {
    dir = mkdtempSync(join(tmpdir(), "lax-past-msg-"));
    mkdirSync(join(dir, "sessions"));
    writeFileSync(join(dir, "sessions", "chat-a.jsonl"), [
      JSON.stringify({ kind: "meta", id: "chat-a", title: "Things with my wife", createdAt: Date.UTC(2026, 9, 5, 12), updatedAt: 0 }),
      JSON.stringify({ kind: "msg", message: { role: "user", content: "We have another long car ride today" }, id: "um-op_2-init-b", createdAt: "2026-10-07T17:28:16.608Z" }),
      JSON.stringify({ kind: "msg", message: { role: "user", content: "but he was hedging his bet" }, id: "sm-x", createdAt: "2026-10-07T17:28:35.570Z", timeUnknown: true }),
    ].join("\n") + "\n");
    return { dataDir: dir } as unknown as MemoryIndex;
  }

  it("returns the whole message with its exact time and chat, fenced as prior-session", () => {
    const out = readPastMessage(setup(), "um-op_2-init-b");
    expect(out).toContain("We have another long car ride today");
    expect(out).toMatch(/date="2026-10-0[67] \d\d:\d\d local"/);
    expect(out).toContain('chat="Things with my wife"');
    expect(out).toContain("PRIOR session");
  });

  it("an unknown-time message is dated by its chat's start, flagged", () => {
    expect(readPastMessage(setup(), "sm-x")).toContain('date="2026-10-05 (chat start; exact time unknown)"');
  });

  it("an id that is nowhere says so", () => {
    expect(readPastMessage(setup(), "nope")).toContain("Not found in any stored session.");
  });
});

// 2026-10-08 eval run: a fact saved at 20:55 local was shown dated "2026-10-09"
// (UTC) beside a prompt saying today is Oct 8; the agent called the date
// impossible and the fact unsupported. Its past-session search also returned
// the current chat's own answer under a header calling it a PRIOR session.
describe("memory dates read in the prompt's clock", () => {
  const savedTz = process.env.TZ;
  afterEach(() => { process.env.TZ = savedTz; });

  it("localDate is the local calendar day, not the UTC one", () => {
    process.env.TZ = "America/Chicago";
    expect(localDate(Date.UTC(2026, 9, 9, 3, 55))).toBe("2026-10-08");
  });

  it("memory_recall labels a fact's date as when it was recorded, in local time", async () => {
    process.env.TZ = "America/Chicago";
    const fact = { id: 1, kind: "experience", content: 'In 2014 Odalys texted "did you sell Merriweather yet".', entities: ["odalys"],
      confidence: 1, timestamp: Date.UTC(2026, 9, 9, 3, 55), sourceFile: "agent-tool:user-statement", sourceLine: 1 };
    const memory = { recallByEntity: () => [fact], reinforceFacts: () => {} } as unknown as MemoryIndex;
    const out = await memoryRecallTool(memory).execute({ entity: "odalys" });
    expect(out.content).toContain("— recorded 2026-10-08 (agent-tool:user-statement");
    expect(out.content).not.toContain("2026-10-09");
  });
});

describe("search_past_sessions marks a hit from the current chat", () => {
  it("names the full session and flags THIS chat, so the agent's own answer is not read as a prior record", async () => {
    const hit = (session_id: string, snippet: string) => ({ source: "session", path: "p", startLine: 1, endLine: 1, score: 0.5, snippet,
      provenance: { source_type: "agent-x-session", trust_status: "mixed", taint_status: "unknown", label: "Local session transcript", session_id } });
    const memory = { search: async () => [
      hit("eval-hold-sourced-claim-1-sfaaxh", "[assistant] Your cousin Odalys texted your brother…"),
      hit("eval-hold-sourced-claim-0-k8z9cm", "[user] Remember this for later: in 2014 my cousin Odalys texted…"),
    ] } as unknown as MemoryIndex;
    const out = (await searchPastSessionsTool(memory).execute({ query: "Merriweather", _sessionId: "eval-hold-sourced-claim-1-sfaaxh" })).content;
    expect(out).toContain("session=eval-hold-sourced-claim-1-sfaaxh (THIS chat — not a prior session)");
    expect(out).toContain("session=eval-hold-sourced-claim-0-k8z9cm score");
  });
});
