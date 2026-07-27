/**
 * Behaviour of the IMAP data layer, driven against a fake ImapFlow.
 *
 * The fake models the parts of IMAP that the bugs in this layer lived in:
 * sequence ranges (where `"*"` means the LAST message), UID ranges, mailbox
 * size, and the connection lifecycle. Assertions are about what a caller
 * observes — how many messages come back, whether it can tell it was truncated,
 * whether the socket was closed — never about how the module is written.
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
  source?: string;
  bodyStructure?: unknown;
  parts?: Record<string, { text: string; charset?: string }>;
}

const h = vi.hoisted(() => {
  const state = {
    messages: [] as FakeMsg[],
    calls: [] as string[],
    lastSearchQuery: undefined as unknown,
    lastFetchRange: undefined as unknown,
    lastFetchByUid: undefined as boolean | undefined,
    moves: [] as { uids: number[]; destination: string }[],
    flagOps: [] as { uids: number[]; flags: string[]; action: string }[],
    folders: [] as { path: string; name: string; specialUse?: string; subscribed: boolean }[],
    failConnect: false,
    failFetch: false,
    reset(): void {
      state.messages = [];
      state.calls = [];
      state.lastSearchQuery = undefined;
      state.lastFetchRange = undefined;
      state.lastFetchByUid = undefined;
      state.moves = [];
      state.flagOps = [];
      state.folders = [];
      state.failConnect = false;
      state.failFetch = false;
    },
  };

  function seqSlice(msgs: FakeMsg[], range: string): FakeMsg[] {
    const [a, b] = String(range).split(":");
    const start = a === "*" ? msgs.length : Number(a);
    const end = b === undefined ? start : b === "*" ? msgs.length : Number(b);
    return msgs.slice(Math.max(0, start - 1), end);
  }

  function shape(m: FakeMsg): unknown {
    return {
      uid: m.uid,
      envelope: { from: [m.from], subject: m.subject, date: m.date, messageId: m.messageId },
      source: m.source === undefined ? undefined : Buffer.from(m.source, "utf-8"),
      bodyStructure: m.bodyStructure,
    };
  }

  function matches(m: FakeMsg, q: Record<string, unknown>): boolean {
    if (Array.isArray(q.or)) return (q.or as Record<string, unknown>[]).some((sub) => matches(m, sub));
    if (q.all) return true;
    if (typeof q.from === "string" && !`${m.from.name} ${m.from.address}`.toLowerCase().includes(q.from.toLowerCase())) return false;
    if (typeof q.subject === "string" && !m.subject.toLowerCase().includes(q.subject.toLowerCase())) return false;
    if (q.seen === false && m.seen) return false;
    if (q.before instanceof Date && !(m.date < q.before)) return false;
    if (q.since instanceof Date && !(m.date >= q.since)) return false;
    return true;
  }

  class FakeImapFlow {
    mailbox: { exists: number } | false = false;
    constructor(_opts: unknown) { state.calls.push("construct"); }
    async connect(): Promise<void> {
      state.calls.push("connect");
      if (state.failConnect) throw new Error("connect refused");
    }
    async getMailboxLock(path: string): Promise<{ release: () => void }> {
      state.calls.push(`lock:${path}`);
      this.mailbox = { exists: state.messages.length };
      return { release: () => { state.calls.push("release"); } };
    }
    async logout(): Promise<void> { state.calls.push("logout"); }
    close(): void { state.calls.push("close"); }
    async *fetch(range: unknown, _query: unknown, options?: { uid?: boolean }): AsyncGenerator<unknown> {
      state.calls.push("fetch");
      state.lastFetchRange = range;
      state.lastFetchByUid = options?.uid;
      if (state.failFetch) throw new Error("fetch exploded");
      const picked = options?.uid
        ? state.messages.filter((m) => (range as number[]).includes(m.uid))
        : seqSlice(state.messages, range as string);
      for (const m of picked) yield shape(m);
    }
    async fetchAll(range: unknown, _query: unknown, options?: { uid?: boolean }): Promise<unknown[]> {
      state.calls.push("fetchAll");
      const uid = Number(String(range));
      const found = options?.uid ? state.messages.filter((m) => m.uid === uid) : [];
      return found.map(shape);
    }
    async search(query: Record<string, unknown>): Promise<number[]> {
      state.calls.push("search");
      state.lastSearchQuery = query;
      return state.messages.filter((m) => matches(m, query)).map((m) => m.uid);
    }
    async download(range: string, part: string): Promise<{ meta: { charset?: string }; content: import("node:stream").Readable }> {
      state.calls.push(`download:${part}`);
      const { Readable } = await import("node:stream");
      const msg = state.messages.find((m) => m.uid === Number(range));
      const chosen = msg?.parts?.[part];
      if (!chosen) throw new Error(`no part ${part}`);
      return { meta: { charset: chosen.charset }, content: Readable.from([Buffer.from(chosen.text, "utf-8")]) };
    }
    async messageMove(uids: number[], destination: string): Promise<{ uidMap: Map<number, number> }> {
      state.calls.push("move");
      state.moves.push({ uids, destination });
      return { uidMap: new Map() };
    }
    async messageFlagsAdd(uids: number[], flags: string[]): Promise<boolean> {
      state.calls.push("flagsAdd");
      state.flagOps.push({ uids, flags, action: "add" });
      return true;
    }
    async messageFlagsRemove(uids: number[], flags: string[]): Promise<boolean> {
      state.calls.push("flagsRemove");
      state.flagOps.push({ uids, flags, action: "remove" });
      return true;
    }
    async list(): Promise<unknown[]> {
      state.calls.push("list");
      return state.folders;
    }
  }

  return { state, FakeImapFlow };
});

vi.mock("imapflow", () => ({ ImapFlow: h.FakeImapFlow }));

const state = h.state;

const {
  fetchMessages, searchMessages, fetchBody, moveMessages, setFlags, listFolders,
} = await import("./email-imap.js");
const { emailRead, emailSearch } = await import("./email-read-tools.js");
const { BODY_CHAR_LIMIT } = await import("./email-body-render.js");

const CFG = { host: "imap.example.com", port: 993, user: "me@example.com", pass: "secret" };

function makeMessages(count: number, overrides: Partial<FakeMsg> = {}): FakeMsg[] {
  return Array.from({ length: count }, (_, i) => ({
    uid: 1000 + i,
    subject: `Message ${i + 1}`,
    from: { name: "Sender", address: `sender${i + 1}@example.com` },
    date: new Date(Date.UTC(2026, 0, 1 + i)),
    messageId: `<msg-${i + 1}@example.com>`,
    source: `Subject: Message ${i + 1}\r\n\r\nBody of message ${i + 1}.`,
    ...overrides,
  }));
}

beforeEach(() => { state.reset(); });

describe("fetchMessages — recent page", () => {
  it("returns `limit` messages, not the single last one", async () => {
    state.messages = makeMessages(25);
    const page = await fetchMessages(CFG, "INBOX", null, 10);
    expect(page.returned).toBe(10);
    expect(page.messages).toHaveLength(10);
    // The most recent ten, i.e. the tail of the mailbox.
    expect(page.messages.map((m) => m.uid)).toEqual([1015, 1016, 1017, 1018, 1019, 1020, 1021, 1022, 1023, 1024]);
  });

  it("carries the uid of every message so a caller can act on them", async () => {
    state.messages = makeMessages(3);
    const page = await fetchMessages(CFG, "INBOX", null, 10);
    expect(page.messages.map((m) => m.uid)).toEqual([1000, 1001, 1002]);
    for (const m of page.messages) expect(Number.isInteger(m.uid)).toBe(true);
  });

  it("carries the message-id for reply threading", async () => {
    state.messages = makeMessages(2);
    const page = await fetchMessages(CFG, "INBOX", null, 10);
    expect(page.messages.map((m) => m.messageId)).toEqual(["<msg-1@example.com>", "<msg-2@example.com>"]);
  });

  it("reports the true total when the page is truncated", async () => {
    state.messages = makeMessages(4000);
    const page = await fetchMessages(CFG, "INBOX", null, 10);
    expect(page.returned).toBe(10);
    expect(page.total).toBe(4000);
    expect(page.truncated).toBe(true);
  });

  it("is not truncated when everything fits", async () => {
    state.messages = makeMessages(4);
    const page = await fetchMessages(CFG, "INBOX", null, 10);
    expect(page).toMatchObject({ total: 4, returned: 4, truncated: false });
  });

  it("returns an empty page for an empty mailbox without fetching", async () => {
    const page = await fetchMessages(CFG, "INBOX", null, 10);
    expect(page).toEqual({ messages: [], total: 0, returned: 0, truncated: false });
    expect(state.calls).not.toContain("fetch");
  });

  it("renders an html snippet as text rather than markup", async () => {
    state.messages = makeMessages(1, {
      source: 'Content-Type: text/html\r\n\r\n<div style="x"><p>Your order <b>shipped</b>.</p></div>',
    });
    const page = await fetchMessages(CFG, "INBOX", null, 10);
    expect(page.messages[0].snippet).toBe("Your order shipped.");
  });
});

describe("fetchMessages — explicit uid set", () => {
  it("reports the total of the whole uid set, not just the page", async () => {
    state.messages = makeMessages(50);
    const uids = state.messages.map((m) => m.uid);
    const page = await fetchMessages(CFG, "INBOX", uids, 5);
    expect(page.returned).toBe(5);
    expect(page.total).toBe(50);
    expect(page.truncated).toBe(true);
    expect(state.lastFetchByUid).toBe(true);
  });
});

describe("searchMessages", () => {
  it("matches a date window", async () => {
    state.messages = makeMessages(10); // Jan 1..10 2026
    const page = await searchMessages(
      CFG, "INBOX",
      { since: new Date(Date.UTC(2026, 0, 4)), before: new Date(Date.UTC(2026, 0, 7)) },
      50,
    );
    expect(page.messages.map((m) => m.subject)).toEqual(["Message 4", "Message 5", "Message 6"]);
    expect(page.total).toBe(3);
  });

  it("expresses 'from X older than a year' as one criteria object", async () => {
    const cutoff = new Date(Date.UTC(2026, 0, 6));
    state.messages = makeMessages(10).map((m, i) => (
      i % 2 === 0 ? { ...m, from: { name: "No Reply", address: "noreply@x.com" } } : m
    ));
    const page = await searchMessages(CFG, "INBOX", { from: "noreply@x.com", before: cutoff }, 50);
    expect(page.messages.map((m) => m.subject)).toEqual(["Message 1", "Message 3", "Message 5"]);
    expect(state.lastSearchQuery).toEqual({ from: "noreply@x.com", before: cutoff });
  });

  it("maps unreadOnly onto the seen flag", async () => {
    state.messages = makeMessages(4).map((m, i) => ({ ...m, seen: i < 2 }));
    const page = await searchMessages(CFG, "INBOX", { unreadOnly: true }, 50);
    expect(page.messages.map((m) => m.subject)).toEqual(["Message 3", "Message 4"]);
  });

  it("combines predicates with OR via anyOf", async () => {
    state.messages = makeMessages(4).map((m, i) => (
      i === 0 ? { ...m, subject: "invoice due" } : i === 1 ? { ...m, from: { name: "Invoice Bot", address: "bot@x.com" } } : m
    ));
    const page = await searchMessages(CFG, "INBOX", { anyOf: [{ subject: "invoice" }, { from: "invoice" }] }, 50);
    expect(page.messages.map((m) => m.uid)).toEqual([1000, 1001]);
  });

  it("searches and fetches over a single connection", async () => {
    state.messages = makeMessages(3);
    await searchMessages(CFG, "INBOX", { subject: "Message" }, 10);
    expect(state.calls.filter((c) => c === "connect")).toHaveLength(1);
    expect(state.calls.filter((c) => c === "logout")).toHaveLength(1);
  });
});

describe("fetchBody", () => {
  const plainStructure = { type: "text/plain", part: undefined, parameters: { charset: "utf-8" }, size: 20 };

  it("returns readable text for a plain-text message", async () => {
    state.messages = makeMessages(1, {
      bodyStructure: plainStructure,
      parts: { "1": { text: "Hi Peter,\r\n\r\nThe invoice is attached.\r\n" } },
    });
    const body = await fetchBody(CFG, "INBOX", 1000);
    expect(body.body).toBe("Hi Peter,\n\nThe invoice is attached.");
    expect(body.contentType).toBe("text/plain");
    expect(body.truncated).toBe(false);
    expect(body.uid).toBe(1000);
  });

  it("renders an html-only message as text, keeping link targets", async () => {
    state.messages = makeMessages(1, {
      bodyStructure: { type: "text/html", size: 200 },
      parts: {
        "1": {
          text: '<html><head><style>p{color:red}</style></head><body><p>Order&nbsp;#42 shipped.</p>'
            + '<p>Track it <a href="https://track.example.com/42">here</a>.</p></body></html>',
        },
      },
    });
    const body = await fetchBody(CFG, "INBOX", 1000);
    expect(body.contentType).toBe("text/html");
    expect(body.body).not.toMatch(/</);
    expect(body.body).toContain("Order #42 shipped.");
    expect(body.body).toContain("here (https://track.example.com/42)");
    expect(body.body).not.toContain("color:red");
  });

  it("prefers the text/plain part of a multipart/alternative message", async () => {
    state.messages = makeMessages(1, {
      bodyStructure: {
        type: "multipart/alternative",
        childNodes: [
          { part: "1", type: "text/plain", size: 10 },
          { part: "2", type: "text/html", size: 400 },
        ],
      },
      parts: { "1": { text: "plain version" }, "2": { text: "<p>html version</p>" } },
    });
    const body = await fetchBody(CFG, "INBOX", 1000);
    expect(body.body).toBe("plain version");
    expect(state.calls).toContain("download:1");
    expect(state.calls).not.toContain("download:2");
  });

  it("returns attachment names and sizes but never their bytes", async () => {
    state.messages = makeMessages(1, {
      bodyStructure: {
        type: "multipart/mixed",
        childNodes: [
          { part: "1", type: "text/plain", size: 10 },
          { part: "2", type: "application/pdf", size: 51234, disposition: "attachment", dispositionParameters: { filename: "invoice.pdf" } },
        ],
      },
      parts: { "1": { text: "see attached" } },
    });
    const body = await fetchBody(CFG, "INBOX", 1000);
    expect(body.attachments).toEqual([{ filename: "invoice.pdf", mimeType: "application/pdf", size: 51234 }]);
    expect(body.body).toBe("see attached");
    expect(state.calls).not.toContain("download:2");
  });

  it("caps an oversized body and says so", async () => {
    state.messages = makeMessages(1, {
      bodyStructure: plainStructure,
      parts: { "1": { text: "x".repeat(BODY_CHAR_LIMIT + 5_000) } },
    });
    const body = await fetchBody(CFG, "INBOX", 1000);
    expect(body.body.length).toBe(BODY_CHAR_LIMIT);
    expect(body.truncated).toBe(true);
  });

  it("reports no text body rather than dumping a non-text part", async () => {
    state.messages = makeMessages(1, {
      bodyStructure: { type: "image/jpeg", part: "1", size: 900, disposition: "attachment", dispositionParameters: { filename: "photo.jpg" } },
      parts: {},
    });
    const body = await fetchBody(CFG, "INBOX", 1000);
    expect(body.contentType).toBeNull();
    expect(body.body).toBe("");
    expect(body.attachments.map((a) => a.filename)).toEqual(["photo.jpg"]);
  });

  it("fails loudly for an unknown uid", async () => {
    state.messages = makeMessages(1);
    await expect(fetchBody(CFG, "INBOX", 999)).rejects.toThrow(/uid 999 not found/);
  });
});

describe("move and flag primitives", () => {
  it("relocates a uid set to a named folder", async () => {
    state.messages = makeMessages(3);
    const result = await moveMessages(CFG, "INBOX", [1000, 1002], "[Gmail]/Trash");
    expect(result).toEqual({ moved: 2, destination: "[Gmail]/Trash" });
    expect(state.moves).toEqual([{ uids: [1000, 1002], destination: "[Gmail]/Trash" }]);
  });

  it("does not open a connection for an empty move", async () => {
    await moveMessages(CFG, "INBOX", [], "[Gmail]/Trash");
    expect(state.calls).toEqual([]);
  });

  it("adds and removes flags", async () => {
    state.messages = makeMessages(2);
    await setFlags(CFG, "INBOX", [1000], ["\\Seen"], "add");
    await setFlags(CFG, "INBOX", [1000, 1001], ["\\Flagged"], "remove");
    expect(state.flagOps).toEqual([
      { uids: [1000], flags: ["\\Seen"], action: "add" },
      { uids: [1000, 1001], flags: ["\\Flagged"], action: "remove" },
    ]);
  });

  it("never expunges — deletion is a move (decision E1)", async () => {
    state.messages = makeMessages(1);
    await moveMessages(CFG, "INBOX", [1000], "Trash");
    expect(state.calls).not.toContain("expunge");
    expect(state.calls).not.toContain("messageDelete");
  });

  it("lists folders so callers stop guessing at trash paths", async () => {
    state.folders = [
      { path: "INBOX", name: "INBOX", subscribed: true },
      { path: "[Gmail]/Trash", name: "Trash", specialUse: "\\Trash", subscribed: true },
    ];
    const folders = await listFolders(CFG);
    expect(folders).toEqual([
      { path: "INBOX", name: "INBOX", specialUse: null, subscribed: true },
      { path: "[Gmail]/Trash", name: "Trash", specialUse: "\\Trash", subscribed: true },
    ]);
  });
});

describe("connection lifecycle", () => {
  it("releases the lock before logging out, exactly once each", async () => {
    state.messages = makeMessages(2);
    await fetchMessages(CFG, "INBOX", null, 10);
    expect(state.calls).toEqual(["construct", "connect", "lock:INBOX", "fetch", "release", "logout", "close"]);
  });

  it("closes the connection when the operation throws", async () => {
    state.messages = makeMessages(2);
    state.failFetch = true;
    await expect(fetchMessages(CFG, "INBOX", null, 10)).rejects.toThrow(/fetch exploded/);
    expect(state.calls).toEqual(["construct", "connect", "lock:INBOX", "fetch", "release", "logout", "close"]);
  });

  it("closes the socket when connecting itself fails", async () => {
    state.failConnect = true;
    await expect(fetchMessages(CFG, "INBOX", null, 10)).rejects.toThrow(/connect refused/);
    expect(state.calls).toEqual(["construct", "connect", "close"]);
  });
});

describe("the read tools on top of the data layer", () => {
  const IMAP_ENV = ["IMAP_HOST", "IMAP_USER", "IMAP_PASS", "IMAP_PORT"];
  let saved: Record<string, string | undefined>;
  let dataDir: string;

  beforeEach(() => {
    saved = Object.fromEntries([...IMAP_ENV, "LAX_DATA_DIR"].map((k) => [k, process.env[k]]));
    dataDir = mkdtempSync(join(tmpdir(), "email-imap-"));
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

  it("email_read returns `limit` messages and the true total", async () => {
    state.messages = makeMessages(4000);
    const result = await emailRead.execute({ limit: 10 });
    expect(result.isError).toBeFalsy();
    const payload = JSON.parse(String(result.content));
    expect(payload.messages).toHaveLength(10);
    expect(payload.total).toBe(4000);
    expect(payload.truncated).toBe(true);
    expect(result.metadata).toMatchObject({ count: 10, total: 4000, truncated: true });
    expect(payload.messages[0].uid).toBeTypeOf("number");
  });

  it("email_read unread_only still filters to unread", async () => {
    state.messages = makeMessages(4).map((m, i) => ({ ...m, seen: i < 3 }));
    const result = await emailRead.execute({ unread_only: true });
    const payload = JSON.parse(String(result.content));
    expect(payload.messages.map((m: { subject: string }) => m.subject)).toEqual(["Message 4"]);
  });

  it("email_read reports no unread messages without erroring", async () => {
    state.messages = makeMessages(2).map((m) => ({ ...m, seen: true }));
    const result = await emailRead.execute({ unread_only: true });
    expect(result.content).toBe("No unread messages found.");
    expect(result.isError).toBeFalsy();
  });

  it("email_search still matches subject OR sender", async () => {
    state.messages = makeMessages(4).map((m, i) => (
      i === 0 ? { ...m, subject: "quarterly invoice" }
        : i === 1 ? { ...m, from: { name: "Invoice Bot", address: "bot@x.com" } }
          : m
    ));
    const result = await emailSearch.execute({ query: "invoice" });
    const payload = JSON.parse(String(result.content));
    expect(payload.messages.map((m: { uid: number }) => m.uid)).toEqual([1000, 1001]);
  });

  it("email_search surfaces the configuration error instead of connecting", async () => {
    delete process.env.IMAP_HOST;
    const result = await emailSearch.execute({ query: "x" });
    expect(result.isError).toBe(true);
    expect(state.calls).toEqual([]);
  });
});
