// The exact mode of search_past_sessions: where something was said, word for
// word, and every time it was. The ranked search returns its best few hits
// from the index, which holds no tool output and paraphrases nothing back
// exactly; asked for every place a phrase came up (2026-10-28), only a scan of
// the transcripts themselves answers.
import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { exactPastSearch } from "./exact-past-search.js";
import { searchPastSessionsTool } from "./search-past-sessions.js";
import { clearExternalIngestion, hasExternalIngestion } from "../../../data-lineage/external.js";
import type { MemoryIndex } from "../../index.js";

vi.mock("./app-matcher.js", () => ({ findMatchingApps: async () => [] }));

let dir = "";
afterEach(() => { if (dir) rmSync(dir, { recursive: true, force: true }); dir = ""; });

type Row = Record<string, unknown>;
const meta = (id: string, title: string): Row => ({ kind: "meta", id, title, createdAt: 1, updatedAt: 2 });
const msg = (id: string, at: string, message: Row): Row => ({ kind: "msg", id, createdAt: at, message });

function setup(sessions: Record<string, Row[]>): string {
  dir = mkdtempSync(join(tmpdir(), "exact-past-"));
  mkdirSync(join(dir, "sessions"));
  for (const [id, rows] of Object.entries(sessions)) {
    writeFileSync(join(dir, "sessions", `${id}.jsonl`), rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
  }
  return dir;
}

const embeddings = {
  "chat-a": [
    meta("chat-a", "project docs"),
    msg("um-1", "2026-10-27T10:00:00.000Z", { role: "user", content: "With Cloud Embeddings, do documents leave the machine?" }),
    msg("am-1", "2026-10-27T10:00:05.000Z", { role: "assistant", content: "Checking.", tool_calls: [{ id: "t1", type: "function", function: { name: "bash", arguments: "{\"command\":\"grep -r cloud embeddings src\"}" } }] }),
    msg("tm-1", "2026-10-27T10:00:06.000Z", { role: "tool", tool_call_id: "t1", content: "src/x.ts: // with cloud embeddings, keyword search only" }),
    msg("um-2", "2026-10-27T10:01:00.000Z", { role: "user", content: "Recalled memory: cloud embeddings note", _harness: "recall" }),
  ],
  "chat-b": [
    meta("chat-b", "later"),
    msg("um-3", "2026-10-28T09:00:00.000Z", { role: "user", content: "cloud embeddings again, cloud embeddings twice" }),
  ],
  "dream-1793208444657": [
    meta("dream-1793208444657", "Memory Dream"),
    msg("dm-1", "2026-10-28T11:00:00.000Z", { role: "user", content: "# Dream: consolidate cloud embeddings" }),
  ],
  "cron-daily-1": [
    meta("cron-daily-1", "daily"),
    msg("cm-1", "2026-10-26T08:00:00.000Z", { role: "user", content: "summarize cloud embeddings pricing" }),
  ],
};

describe("exactPastSearch — every message that contains the text", () => {
  it("finds user, assistant tool calls and tool output, newest first, case aside, with a count per chat", async () => {
    const { hits, chats } = await exactPastSearch(setup(embeddings), "cloud embeddings");
    expect(hits.map((h) => h.messageId)).toEqual(["um-3", "tm-1", "am-1", "um-1", "cm-1"]);
    expect(hits[0].count).toBe(2);
    expect(hits.find((h) => h.messageId === "tm-1")).toMatchObject({ role: "tool", tool: "bash", title: "project docs" });
    expect(hits.find((h) => h.messageId === "am-1")).toMatchObject({ role: "assistant", tool: "bash" });
    expect(hits.find((h) => h.messageId === "um-1")?.excerpt).toContain("With Cloud Embeddings");
    expect(chats).toEqual([
      { sessionId: "chat-b", title: "later", messages: 1 },
      { sessionId: "chat-a", title: "project docs", messages: 3 },
      { sessionId: "cron-daily-1", title: "daily", messages: 1 },
    ]);
  });

  it("never returns what the harness wrote or a dream run", async () => {
    const { hits } = await exactPastSearch(setup(embeddings), "cloud embeddings");
    expect(hits.some((h) => h.messageId === "um-2" || h.sessionId.startsWith("dream-"))).toBe(false);
  });

  it("matches text JSON escapes on disk: quotes, backslashes and line breaks", async () => {
    const d = setup({ "chat-q": [meta("chat-q", "q"), msg("um-q", "2026-10-20T00:00:00.000Z", { role: "user", content: "run it with \"C:\\temp\\x\"\nthen stop" })] });
    expect((await exactPastSearch(d, "\"C:\\temp\\x\"")).hits.map((h) => h.messageId)).toEqual(["um-q"]);
    expect((await exactPastSearch(d, "x\"\nthen")).hits).toHaveLength(1);
    expect((await exactPastSearch(d, "temp x")).hits).toHaveLength(0);
  });

  it("since drops older messages, and skips an untouched older file unread", async () => {
    const d = setup(embeddings);
    utimesSync(join(d, "sessions", "cron-daily-1.jsonl"), new Date("2026-10-26T08:00:00Z"), new Date("2026-10-26T08:00:00Z"));
    const { hits } = await exactPastSearch(d, "cloud embeddings", { since: new Date("2026-10-27T10:00:01Z") });
    expect(hits.map((h) => h.messageId)).toEqual(["um-3", "tm-1", "am-1"]);
  });
});

describe("search_past_sessions exact", () => {
  const run = (d: string, args: Record<string, unknown>) =>
    searchPastSessionsTool({ dataDir: d } as unknown as MemoryIndex).execute({ ...args, _sessionId: "chat-b" });

  it("lists every chat with a count, marks the current chat, and caps the messages shown", async () => {
    const out = (await run(setup(embeddings), { exact: "Cloud Embeddings", max_results: 2 })).content;
    expect(out).toContain('matches="5" chats="3"');
    expect(out).toContain("5 message(s) in 3 chat(s) contain this text; the newest 2 are shown");
    expect(out).toMatch(/"later" session=chat-b \(THIS chat\): 1 message/);
    expect(out).toContain("message_id=um-3");
    expect(out).toContain("message_id=tm-1");
    expect(out).not.toContain("message_id=am-1");
  });

  it("masks a secret in old tool output, wraps the result as external content, and marks the session", async () => {
    clearExternalIngestion("chat-b");
    const token = "ghp_" + "Qx7".repeat(12);
    const d = setup({ "chat-s": [
      meta("chat-s", "deploy"),
      msg("am-s", "2026-10-25T00:00:00.000Z", { role: "assistant", content: "", tool_calls: [{ id: "s1", type: "function", function: { name: "bash", arguments: "{\"command\":\"gh auth status\"}" } }] }),
      msg("tm-s", "2026-10-25T00:00:01.000Z", { role: "tool", tool_call_id: "s1", content: `deploy key in use: token ${token}` }),
    ] });
    const out = (await run(d, { exact: "deploy key" })).content;
    expect(out).not.toContain(token);
    expect(out).toContain("secret value");
    expect(out).toMatch(/<<<EXTERNAL|UNTRUSTED/);
    expect(hasExternalIngestion("chat-b")).toBe(true);
    clearExternalIngestion("chat-b");
  });

  it("says plainly when nothing matches, and refuses a one-character phrase", async () => {
    const d = setup(embeddings);
    expect((await run(d, { exact: "nowhere said" })).content).toContain('matches="0"');
    expect((await run(d, { exact: "x" })).isError).toBe(true);
  });
});
