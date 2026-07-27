/**
 * Behaviour of the three read TOOLS as a model experiences them: what it can
 * express in the arguments, and what it can see in `content`.
 *
 * Everything is asserted through `execute()` and the serialized result — never
 * against the criteria object handed to the data layer — because the thing that
 * breaks is "the model asked for last year's mail and got this month's", not
 * "the criteria object had the wrong key". The fake IMAP server below is
 * therefore a real filter: it applies from/subject/body/seen/before/since the
 * way RFC 3501 does, so a mis-mapped predicate shows up as the wrong messages.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

interface FakeMsg {
  uid: number;
  subject: string;
  from: { name: string; address: string };
  date: Date;
  messageId: string;
  seen?: boolean;
  body?: string;
  source?: string;
  bodyStructure?: unknown;
  parts?: Record<string, string>;
}

const h = vi.hoisted(() => {
  const state = {
    messages: [] as FakeMsg[],
    calls: [] as string[],
    reset(): void { state.messages = []; state.calls = []; },
  };

  function seqSlice(msgs: FakeMsg[], range: string): FakeMsg[] {
    const [a, b] = String(range).split(":");
    const start = a === "*" ? msgs.length : Number(a);
    const end = b === undefined ? start : b === "*" ? msgs.length : Number(b);
    return msgs.slice(Math.max(0, start - 1), end);
  }

  function shape(m: FakeMsg, query?: Record<string, unknown>): unknown {
    const want = (k: string): boolean => query === undefined || Boolean(query[k]);
    const out: Record<string, unknown> = { uid: m.uid };
    if (want("envelope")) out.envelope = { from: [m.from], subject: m.subject, date: m.date, messageId: m.messageId };
    if (want("source") && m.source !== undefined) out.source = Buffer.from(m.source, "utf-8");
    if (want("bodyStructure")) out.bodyStructure = m.bodyStructure;
    return out;
  }

  function has(hay: string, needle: unknown): boolean {
    return typeof needle !== "string" || hay.toLowerCase().includes(needle.toLowerCase());
  }

  function matches(m: FakeMsg, q: Record<string, unknown>): boolean {
    if (Array.isArray(q.or) && !(q.or as Record<string, unknown>[]).some((sub) => matches(m, sub))) return false;
    if (q.all) return true;
    if (!has(`${m.from.name} ${m.from.address}`, q.from)) return false;
    if (!has(m.subject, q.subject)) return false;
    if (!has(m.body ?? m.source ?? "", q.body)) return false;
    if (q.seen === false && m.seen) return false;
    if (q.before instanceof Date && !(m.date < q.before)) return false;
    if (q.since instanceof Date && !(m.date >= q.since)) return false;
    return true;
  }

  class FakeImapFlow {
    mailbox: { exists: number } | false = false;
    constructor(_opts: unknown) { state.calls.push("construct"); }
    async connect(): Promise<void> { state.calls.push("connect"); }
    async getMailboxLock(path: string): Promise<{ release: () => void }> {
      state.calls.push(`lock:${path}`);
      this.mailbox = { exists: state.messages.length };
      return { release: () => { state.calls.push("release"); } };
    }
    async logout(): Promise<void> { state.calls.push("logout"); }
    close(): void { state.calls.push("close"); }
    async *fetch(range: unknown, query: Record<string, unknown>, options?: { uid?: boolean }): AsyncGenerator<unknown> {
      state.calls.push("fetch");
      const picked = options?.uid
        ? state.messages.filter((m) => (range as number[]).includes(m.uid))
        : seqSlice(state.messages, range as string);
      for (const m of picked) yield shape(m, query);
    }
    async fetchAll(range: unknown, query: Record<string, unknown>, options?: { uid?: boolean }): Promise<unknown[]> {
      state.calls.push("fetchAll");
      const uid = Number(String(range));
      const found = options?.uid ? state.messages.filter((m) => m.uid === uid) : [];
      return found.map((m) => shape(m, query));
    }
    async search(query: Record<string, unknown>): Promise<number[]> {
      state.calls.push("search");
      return state.messages.filter((m) => matches(m, query)).map((m) => m.uid);
    }
    async download(range: string, part: string): Promise<{ meta: { charset?: string }; content: import("node:stream").Readable }> {
      state.calls.push(`download:${part}`);
      const { Readable } = await import("node:stream");
      const text = state.messages.find((m) => m.uid === Number(range))?.parts?.[part];
      if (text === undefined) throw new Error(`no part ${part}`);
      return { meta: {}, content: Readable.from([Buffer.from(text, "utf-8")]) };
    }
  }

  return { state, FakeImapFlow };
});

vi.mock("imapflow", () => ({ ImapFlow: h.FakeImapFlow }));

const state = h.state;
const { emailRead, emailSearch, emailReadMessage, parseDateInput } = await import("./email-read-tools.js");

const CFG = { host: "imap.example.com", port: 993, user: "me@example.com", pass: "secret" };
const DAY = 86_400_000;

function makeMessages(count: number, overrides: Partial<FakeMsg> = {}): FakeMsg[] {
  return Array.from({ length: count }, (_, i) => ({
    uid: 1000 + i,
    subject: `Message ${i + 1}`,
    from: { name: "Sender", address: `sender${i + 1}@example.com` },
    date: new Date(Date.now() - (count - i) * DAY),
    messageId: `<msg-${i + 1}@example.com>`,
    source: `Subject: Message ${i + 1}\r\n\r\nBody of message ${i + 1}.`,
    ...overrides,
  }));
}

/** The result as the model sees it: the parsed content, not the metadata. */
function payloadOf(result: { content?: unknown }): Record<string, unknown> {
  return JSON.parse(String(result.content)) as Record<string, unknown>;
}
function uidsOf(result: { content?: unknown }): number[] {
  return (payloadOf(result).messages as { uid: number }[]).map((m) => m.uid);
}

const IMAP_ENV = ["IMAP_HOST", "IMAP_USER", "IMAP_PASS", "IMAP_PORT"];
let saved: Record<string, string | undefined>;
let dataDir: string;

beforeEach(() => {
  state.reset();
  saved = Object.fromEntries([...IMAP_ENV, "LAX_DATA_DIR"].map((k) => [k, process.env[k]]));
  dataDir = mkdtempSync(join(tmpdir(), "email-read-tools-"));
  process.env.LAX_DATA_DIR = dataDir;
  process.env.IMAP_HOST = CFG.host;
  process.env.IMAP_USER = CFG.user;
  process.env.IMAP_PASS = CFG.pass;
});

afterEach(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  rmSync(dataDir, { recursive: true, force: true });
});

describe("date input", () => {
  const NOW = new Date("2026-07-26T12:00:00Z");

  it("reads an ISO calendar date as UTC midnight", () => {
    expect(parseDateInput("2025-07-26", NOW)).toEqual(new Date("2025-07-26T00:00:00Z"));
  });

  it("reads relative ages the way a model writes them", () => {
    expect(parseDateInput("1 year", NOW)).toEqual(new Date("2025-07-26T12:00:00Z"));
    expect(parseDateInput("a year ago", NOW)).toEqual(new Date("2025-07-26T12:00:00Z"));
    expect(parseDateInput("6 months", NOW)).toEqual(new Date("2026-01-26T12:00:00Z"));
    expect(parseDateInput("30 days", NOW)).toEqual(new Date(NOW.getTime() - 30 * DAY));
    expect(parseDateInput("last week", NOW)).toEqual(new Date(NOW.getTime() - 7 * DAY));
  });

  it("steps the calendar for months instead of assuming a 30-day month", () => {
    // 31 March minus one month is February, not "30 days ago" (= 1 March).
    const march31 = new Date("2026-03-31T00:00:00Z");
    expect(parseDateInput("1 month", march31)).toEqual(new Date("2026-02-28T00:00:00Z"));
    // …and a leap February, reached via the year path (12 months).
    expect(parseDateInput("1 year", new Date("2025-02-28T00:00:00Z"))).toEqual(new Date("2024-02-28T00:00:00Z"));
  });

  it("rejects what it cannot parse rather than inventing a window", () => {
    for (const junk of ["next tuesday", "sometime last summer", "Message 4", "2026", ""]) {
      const parsed = parseDateInput(junk, NOW);
      expect(parsed, `"${junk}" must not parse`).not.toBeInstanceOf(Date);
      expect((parsed as { error: string }).error).toMatch(/date/i);
    }
  });
});

describe("email_search predicates", () => {
  it("finds everything from a sender older than a year — and nothing newer", async () => {
    const old = new Date(Date.now() - 400 * DAY);
    const recent = new Date(Date.now() - 10 * DAY);
    state.messages = [
      { uid: 1, subject: "Old receipt", from: { name: "No Reply", address: "noreply@shop.com" }, date: old, messageId: "<1>" },
      { uid: 2, subject: "New receipt", from: { name: "No Reply", address: "noreply@shop.com" }, date: recent, messageId: "<2>" },
      { uid: 3, subject: "Old note", from: { name: "Alice", address: "alice@x.com" }, date: old, messageId: "<3>" },
    ];
    const result = await emailSearch.execute({ from: "noreply@shop.com", before: "1 year" });
    expect(result.isError).toBeFalsy();
    expect(uidsOf(result)).toEqual([1]);
  });

  it("honours an ISO `since` window", async () => {
    state.messages = [
      { uid: 1, subject: "a", from: { name: "A", address: "a@x.com" }, date: new Date("2026-01-05T00:00:00Z"), messageId: "<1>" },
      { uid: 2, subject: "b", from: { name: "B", address: "b@x.com" }, date: new Date("2026-03-05T00:00:00Z"), messageId: "<2>" },
    ];
    // `since` alone is a real predicate, so this must be a search, not an error.
    const result = await emailSearch.execute({ since: "2026-02-01" });
    expect(result.isError).toBeFalsy();
    expect(uidsOf(result)).toEqual([2]);
  });

  it("refuses an unparseable date instead of searching a guessed window", async () => {
    state.messages = makeMessages(50);
    const result = await emailSearch.execute({ from: "sender1@example.com", before: "sometime last year" });
    expect(result.isError).toBe(true);
    expect(String(result.content)).toMatch(/could not understand the date/i);
    // Nothing was opened: a bad window must cost no connection and select nothing.
    expect(state.calls).toEqual([]);
  });

  it("filters to unread only", async () => {
    state.messages = makeMessages(4).map((m, i) => ({ ...m, seen: i < 3 }));
    const result = await emailSearch.execute({ unread_only: true });
    expect(uidsOf(result)).toEqual([1003]);
  });

  it("keeps free text matching subject OR sender", async () => {
    state.messages = makeMessages(4).map((m, i) => (
      i === 0 ? { ...m, subject: "quarterly invoice" }
        : i === 1 ? { ...m, from: { name: "Invoice Bot", address: "bot@x.com" } }
          : m
    ));
    expect(uidsOf(await emailSearch.execute({ query: "invoice" }))).toEqual([1000, 1001]);
  });

  it("ANDs free text with the explicit predicates rather than replacing them", async () => {
    state.messages = makeMessages(3).map((m, i) => (
      i === 0 ? { ...m, subject: "invoice", from: { name: "Bot", address: "bot@x.com" } }
        : { ...m, subject: "invoice" }
    ));
    // subject/sender OR "invoice", AND from bot@x.com.
    expect(uidsOf(await emailSearch.execute({ query: "invoice", from: "bot@x.com" }))).toEqual([1000]);
  });

  it("searches body text when asked", async () => {
    state.messages = makeMessages(3).map((m, i) => ({ ...m, body: i === 1 ? "please renew your subscription" : "nothing here" }));
    expect(uidsOf(await emailSearch.execute({ body: "renew" }))).toEqual([1001]);
  });

  it("surfaces the whole-mailbox refusal instead of silently returning nothing", async () => {
    state.messages = makeMessages(500);
    const result = await emailSearch.execute({});
    expect(result.isError).toBe(true);
    expect(String(result.content)).toMatch(/entire mailbox/i);
    expect(state.calls).toEqual([]);
  });
});

describe("truncation is visible to the model", () => {
  it("says so in the content, before the messages, when total > returned", async () => {
    state.messages = makeMessages(4000);
    const result = await emailRead.execute({ limit: 10 });
    const raw = String(result.content);
    expect(raw).toMatch(/Showing the 10 most recent of 4000 matching messages/);
    // Before the first message, not buried under a 10-message array.
    expect(raw.indexOf("Showing the 10")).toBeLessThan(raw.indexOf("\"messages\""));
    expect(payloadOf(result)).toMatchObject({ total: 4000, returned: 10, truncated: true });
    expect(result.metadata).toMatchObject({ count: 10, total: 4000, truncated: true });
  });

  it("says so for a truncated search too", async () => {
    state.messages = makeMessages(300).map((m) => ({ ...m, subject: "newsletter" }));
    const result = await emailSearch.execute({ query: "newsletter", limit: 5 });
    expect(String(result.content)).toMatch(/Showing the 5 most recent of 300/);
  });

  it("stays a plain page — no note — when nothing was cut", async () => {
    state.messages = makeMessages(3);
    const result = await emailRead.execute({});
    expect(payloadOf(result)).not.toHaveProperty("note");
    expect(Object.keys(payloadOf(result)).sort()).toEqual(["messages", "returned", "total", "truncated"]);
  });
});

describe("email_read defaults and uids", () => {
  it("with no arguments returns the most recent INBOX messages", async () => {
    state.messages = makeMessages(25);
    const result = await emailRead.execute({});
    expect(uidsOf(result)).toEqual([1015, 1016, 1017, 1018, 1019, 1020, 1021, 1022, 1023, 1024]);
    expect(state.calls).toContain("lock:INBOX");
  });

  it("gives the model a uid for every message it lists", async () => {
    state.messages = makeMessages(3);
    for (const result of [await emailRead.execute({}), await emailSearch.execute({ query: "Message" })]) {
      for (const m of payloadOf(result).messages as { uid: unknown }[]) {
        expect(typeof m.uid).toBe("number");
      }
      expect(uidsOf(result)).toEqual([1000, 1001, 1002]);
    }
  });
});

describe("email_read_message", () => {
  const withBody: FakeMsg = {
    uid: 77,
    subject: "Your invoice",
    from: { name: "Billing", address: "billing@shop.com" },
    date: new Date("2026-05-01T00:00:00Z"),
    messageId: "<inv-77@shop.com>",
    bodyStructure: {
      type: "multipart/mixed",
      childNodes: [
        { part: "1", type: "text/plain", size: 40 },
        { part: "2", type: "application/pdf", size: 5120, disposition: "attachment", dispositionParameters: { filename: "invoice.pdf" } },
      ],
    },
    parts: { "1": "Hello,\r\n\r\nYour invoice for July is attached.\r\n" },
  };

  it("returns the readable body and the attachment metadata", async () => {
    state.messages = [withBody];
    const result = await emailReadMessage.execute({ uid: 77 });
    expect(result.isError).toBeFalsy();
    const payload = payloadOf(result);
    expect(payload.body).toContain("Your invoice for July is attached.");
    expect(payload.uid).toBe(77);
    expect(payload.contentType).toBe("text/plain");
    expect(payload.attachments).toEqual([{ filename: "invoice.pdf", mimeType: "application/pdf", size: 5120 }]);
    expect(result.metadata).toMatchObject({ uid: 77, attachments: 1, truncated: false });
  });

  it("refuses a call with no usable uid without opening a connection", async () => {
    state.messages = [withBody];
    for (const args of [{}, { uid: "abc" }, { uid: 0 }]) {
      const result = await emailReadMessage.execute(args);
      expect(result.isError, JSON.stringify(args)).toBe(true);
      expect(String(result.content)).toMatch(/uid/i);
    }
    expect(state.calls).toEqual([]);
  });

  it("reports a uid that is not in the folder as an error, not an empty body", async () => {
    state.messages = [withBody];
    const result = await emailReadMessage.execute({ uid: 999 });
    expect(result.isError).toBe(true);
    expect(String(result.content)).toMatch(/not found/i);
  });
});
