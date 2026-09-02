import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { randomId } from "../src/util/ids.js";
import {
  CHAT_LIST_HIDDEN_PREFIXES,
  isExcludedFromSessionSummaries,
  isHiddenFromChatLists,
  isSyntheticSessionId,
  SYNTHETIC_SESSION_PREFIXES,
} from "../src/memory/synthetic-sessions.js";

// Regression for the memory_dream self-ingestion blowup: dream globbed every
// *.jsonl in ~/.lax/sessions with NO prefix filter, so each run re-ingested
// prior dream-*.jsonl output (which already embedded earlier transcripts),
// compounding exponentially until a single session file reached 150 MB. The
// fix routes all three session readers (dream input, live index, UI list)
// through this one classifier so a generated session can never be treated as
// real history again.
describe("isSyntheticSessionId", () => {
  it("classifies every generated prefix as synthetic — raw id and .jsonl filename", () => {
    for (const p of SYNTHETIC_SESSION_PREFIXES) {
      expect(isSyntheticSessionId(`${p}1780687489740`)).toBe(true);
      expect(isSyntheticSessionId(`${p}1780687489740.jsonl`)).toBe(true);
    }
  });

  it("the exact file that blew up is excluded (dream's own output)", () => {
    expect(isSyntheticSessionId("dream-1780687489740.jsonl")).toBe(true);
  });

  // Derived from the REAL minter (routes/chat.ts → randomId("eval") →
  // `eval_<16hex>`), not a hand-typed literal: the list said `eval-` from
  // f6e5f7b0 until 2026-08-31 and nothing caught it because the old fixture
  // was typed to match the list rather than the minter.
  it("classifies what /api/eval/run actually mints (randomId('eval') → eval_…)", () => {
    const id = randomId("eval");
    expect(id.startsWith("eval_")).toBe(true); // prefix only — body format is ids.test.ts's pin
    expect(isSyntheticSessionId(id)).toBe(true);
    expect(isSyntheticSessionId(`${id}.jsonl`)).toBe(true);
  });

  it("treats real user conversations as NOT synthetic", () => {
    expect(isSyntheticSessionId("a1b2c3d4-session")).toBe(false);
    expect(isSyntheticSessionId("1780687489740.jsonl")).toBe(false);
    expect(isSyntheticSessionId("daydream-notes")).toBe(false); // substring, not prefix
    expect(isSyntheticSessionId("my-cron-job")).toBe(false);    // prefix must be leading
  });
});

// The OTHER predicate this module owns: chat-list hiding (the UI concern).
// Derived as SYNTHETIC minus ide-. Kept strictly separate from chat-ws/
// broadcast.ts isHeadlessSession ("never interrupts the user"): cron- is
// hidden HERE but must keep nudging — test/idle-nudge-headless.test.ts and
// test/chat-ws-headless-filter.test.ts pin the two sides.
describe("isHiddenFromChatLists — hidden from active_chats and /api/sessions/search", () => {
  it("hides every synthetic prefix except ide-", () => {
    expect([...CHAT_LIST_HIDDEN_PREFIXES].sort()).toEqual(["cron-", "dream-", "eval_", "skill-review-"]);
    for (const prefix of CHAT_LIST_HIDDEN_PREFIXES) {
      expect(isHiddenFromChatLists(`${prefix}1780687489740`)).toBe(true);
    }
  });

  it("what cron-runner.ts actually mints (`cron-<jobId>-<ts>`) is hidden", () => {
    expect(isHiddenFromChatLists(`cron-daily-report-${Date.now()}`)).toBe(true);
  });

  it("skill-review- (SKILL_REVIEW_SESSION_PREFIX, background-jobs/skill-review.ts) is synthetic AND hidden", () => {
    expect(isSyntheticSessionId("skill-review-1756687489740-0")).toBe(true);
    expect(isHiddenFromChatLists("skill-review-1756687489740-0")).toBe(true);
  });

  it("ide- is synthetic (memory + persisted sidebar list) but NOT hidden from live chat lists", () => {
    expect(isSyntheticSessionId("ide-todo-app")).toBe(true);
    expect(isHiddenFromChatLists("ide-todo-app")).toBe(false);
  });

  it("real user chats are never hidden", () => {
    for (const id of ["chat-abc", "wa-111", "tg-222", "voice-1", "fork-deadbeef", "ide-app", "my-cron-job", "dreamer"]) {
      expect(isHiddenFromChatLists(id)).toBe(false);
    }
  });
});

// The THIRD predicate: session summaries (the memory-ingestion concern, the
// FOURTH reader of the synthetic set). memory-bg summarizes recent sessions
// into memory/session-summaries (which universal-index embeds) and
// /api/sessions/summaries + /api/sessions/auto-summarize share the dir —
// none of them filtered, so chatty cron-/dream- transcripts leaked into the
// memory index (same class as dream's 150 MB self-ingestion). Same set as
// chat-list hiding TODAY, but a separate concern: sidebar visibility must
// never silently decide what enters user memory.
describe("isExcludedFromSessionSummaries — internal scratch never becomes user memory", () => {
  it("excludes every synthetic prefix except ide-", () => {
    for (const prefix of SYNTHETIC_SESSION_PREFIXES.filter((p) => p !== "ide-")) {
      expect(isExcludedFromSessionSummaries(`${prefix}1780687489740`)).toBe(true);
      // The summaries route filters raw FILENAMES from disk.
      expect(isExcludedFromSessionSummaries(`${prefix}1780687489740.md`)).toBe(true);
    }
  });

  it("what the real minters produce is excluded (randomId('eval'), cron-<jobId>-<ts>)", () => {
    expect(isExcludedFromSessionSummaries(randomId("eval"))).toBe(true);
    expect(isExcludedFromSessionSummaries(`cron-daily-report-${Date.now()}`)).toBe(true);
  });

  it("ide- keeps summarizing — IDE-panel chats are real user conversations", () => {
    expect(isSyntheticSessionId("ide-todo-app")).toBe(true); // synthetic for the live index…
    expect(isExcludedFromSessionSummaries("ide-todo-app")).toBe(false); // …but summarized as user memory
    expect(isExcludedFromSessionSummaries("ide-todo-app.md")).toBe(false);
  });

  it("real user chats and near-misses are never excluded", () => {
    for (const id of ["chat-abc", "wa-111", "fork-deadbeef", "my-cron-job", "dreamer", "skill-reviewer"]) {
      expect(isExcludedFromSessionSummaries(id)).toBe(false);
    }
  });
});

// One-source-of-truth pin for the new seam: the summarize readers/writers
// import the predicate — they never re-type a prefix. A hand-typed "cron-"
// in either file is exactly the drift that made the four readers diverge in
// the first place (session-helpers 2 prefixes, routes/sessions 4, dream 0,
// memory-bg none at all).
describe("summary seam readers import the predicate — no re-typed prefix literals", () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const files = [
    join(here, "../src/server/background-jobs/memory-bg.ts"),
    join(here, "../src/routes/sessions.ts"),
  ];

  it.each(files)("%s has no quoted synthetic-prefix literal and imports synthetic-sessions", (file) => {
    const src = readFileSync(file, "utf-8");
    expect(src).toMatch(/from "\.\.?\/.*memory\/synthetic-sessions\.js"/);
    for (const prefix of SYNTHETIC_SESSION_PREFIXES) {
      // Quoted occurrences only — prose in comments may name the prefixes.
      expect(src).not.toMatch(new RegExp(`["']${prefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
    }
  });
});
