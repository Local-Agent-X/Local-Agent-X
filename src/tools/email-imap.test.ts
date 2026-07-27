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
  parts?: Record<string, { text?: string; charset?: string; chunks?: () => Iterable<Buffer> }>;
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
    /** Override what messageMove returns: `false` (refused) or a partial
     *  uidMap, as real servers do. Undefined = a healthy UIDPLUS server. */
    moveResult: undefined as unknown,
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
      state.moveResult = undefined;
    },
  };

  function seqSlice(msgs: FakeMsg[], range: string): FakeMsg[] {
    const [a, b] = String(range).split(":");
    const start = a === "*" ? msgs.length : Number(a);
    const end = b === undefined ? start : b === "*" ? msgs.length : Number(b);
    return msgs.slice(Math.max(0, start - 1), end);
  }

  /** Returns ONLY the fields the fetch query asked for, the way a real IMAP
   *  server does. A fake that hands back `source` unconditionally hides every
   *  bug of the form "derived a value from a field we never requested". */
  function shape(m: FakeMsg, query?: Record<string, unknown>): unknown {
    const want = (k: string): boolean => query === undefined || Boolean(query[k]);
    const out: Record<string, unknown> = { uid: m.uid };
    if (want("envelope")) out.envelope = { from: [m.from], subject: m.subject, date: m.date, messageId: m.messageId };
    if (want("source") && m.source !== undefined) out.source = Buffer.from(m.source, "utf-8");
    if (want("bodyStructure")) out.bodyStructure = m.bodyStructure;
    return out;
  }

  function matches(m: FakeMsg, q: Record<string, unknown>): boolean {
    // `or` is ONE conjunct among the sibling keys, not a short-circuit for the
    // whole object — RFC 3501 ANDs it with everything beside it.
    if (Array.isArray(q.or) && !(q.or as Record<string, unknown>[]).some((sub) => matches(m, sub))) return false;
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
    async *fetch(range: unknown, query: Record<string, unknown>, options?: { uid?: boolean }): AsyncGenerator<unknown> {
      state.calls.push("fetch");
      state.lastFetchRange = range;
      state.lastFetchByUid = options?.uid;
      if (state.failFetch) throw new Error("fetch exploded");
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
      state.lastSearchQuery = query;
      return state.messages.filter((m) => matches(m, query)).map((m) => m.uid);
    }
    async download(range: string, part: string): Promise<{ meta: { charset?: string }; content: import("node:stream").Readable }> {
      state.calls.push(`download:${part}`);
      const { Readable } = await import("node:stream");
      const msg = state.messages.find((m) => m.uid === Number(range));
      const chosen = msg?.parts?.[part];
      if (!chosen) throw new Error(`no part ${part}`);
      // `chunks` streams raw bytes lazily, so a test can present a body larger
      // than the wire cap without materialising it, and can present bytes that
      // are not valid UTF-8.
      const content = chosen.chunks
        ? Readable.from(chosen.chunks())
        : Readable.from([Buffer.from(chosen.text ?? "", "utf-8")]);
      return { meta: { charset: chosen.charset }, content };
    }
    async messageMove(uids: number[], destination: string): Promise<unknown> {
      state.calls.push("move");
      state.moves.push({ uids, destination });
      if (state.moveResult !== undefined) return state.moveResult;
      // UIDPLUS server: every requested uid lands, and says so.
      return { uidMap: new Map(uids.map((u, i) => [u, 9000 + i])) };
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
  fetchMessages, searchMessages, fetchBody, moveMessages, setFlags, listFolders, buildSearchQuery,
  withSession,
} = await import("./email-imap.js");
type EmailSearchCriteria = import("./email-imap.js").EmailSearchCriteria;
const { emailRead, emailSearch } = await import("./email-read-tools.js");
const { BODY_CHAR_LIMIT, BODY_BYTE_LIMIT } = await import("./email-body-render.js");

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

  // "The 10 oldest" and "the 10 newest" are different mailboxes once the page
  // feeds a move, and counts alone cannot tell them apart.
  it("pages the NEWEST end of an over-long uid set", async () => {
    state.messages = makeMessages(50);
    const uids = state.messages.map((m) => m.uid);
    const page = await fetchMessages(CFG, "INBOX", uids, 5);
    expect(page.messages.map((m) => m.uid)).toEqual([1045, 1046, 1047, 1048, 1049]);
    expect(state.lastFetchRange).toEqual([1045, 1046, 1047, 1048, 1049]);
  });

  it("pages the NEWEST end of an over-long search result", async () => {
    state.messages = makeMessages(30);
    const page = await searchMessages(CFG, "INBOX", { subject: "Message" }, 3);
    expect(page.total).toBe(30);
    expect(page.messages.map((m) => m.uid)).toEqual([1027, 1028, 1029]);
  });

  it("pages the NEWEST end of an over-long sequence range", async () => {
    state.messages = makeMessages(30);
    const page = await fetchMessages(CFG, "INBOX", null, 3);
    expect(page.messages.map((m) => m.uid)).toEqual([1027, 1028, 1029]);
    expect(state.lastFetchRange).toBe("28:30");
  });
});

describe("empty pages are not shared", () => {
  it("hands out a fresh page each time, so mutating one cannot poison the next", async () => {
    const first = await fetchMessages(CFG, "INBOX", [], 10);
    // The natural thing for a caller to do to a page: sort it, annotate it.
    first.messages.push({ uid: 1, from: "x", subject: "phantom", date: "d", messageId: null, snippet: "" });
    first.total = 999;

    const second = await fetchMessages(CFG, "INBOX", [], 10);
    expect(second).toEqual({ messages: [], total: 0, returned: 0, truncated: false });

    state.messages = makeMessages(2).map((m) => ({ ...m, seen: true }));
    const third = await searchMessages(CFG, "INBOX", { unreadOnly: true }, 10);
    expect(third).toEqual({ messages: [], total: 0, returned: 0, truncated: false });

    // …and a page that does have messages is unaffected either way.
    const fourth = await fetchMessages(CFG, "INBOX", null, 10);
    expect(fourth.returned).toBe(2);
    expect(fourth.messages.map((m) => m.subject)).toEqual(["Message 1", "Message 2"]);
  });
});

describe("buildSearchQuery refuses to widen", () => {
  it("throws on empty criteria rather than matching the whole mailbox", () => {
    expect(() => buildSearchQuery({})).toThrow(/entire mailbox/);
  });

  it("throws on an empty anyOf", () => {
    expect(() => buildSearchQuery({ anyOf: [] })).toThrow(/entire mailbox/);
    expect(() => buildSearchQuery({ anyOf: [{}] })).toThrow(/entire mailbox/);
  });

  it("throws past the anyOf nesting limit instead of dropping the branch", () => {
    // A dropped branch leaves `{}` — and one match-everything alternative
    // makes the WHOLE or match every message.
    let nested: EmailSearchCriteria = { anyOf: [{ from: "a@x.com" }, { from: "b@x.com" }] };
    for (let i = 0; i < 6; i++) nested = { anyOf: [nested, { from: `l${i}@x.com` }] };
    expect(() => buildSearchQuery(nested)).toThrow(/anyOf deeper than/);
  });

  it("never emits all:true for any nesting depth it does accept", () => {
    let nested: EmailSearchCriteria = { anyOf: [{ from: "a@x.com" }, { from: "b@x.com" }] };
    for (let i = 0; i < 3; i++) nested = { anyOf: [nested, { from: `l${i}@x.com` }] };
    expect(JSON.stringify(buildSearchQuery(nested))).not.toContain("all");
  });

  it("opens no connection when the criteria are empty", async () => {
    await expect(searchMessages(CFG, "INBOX", {}, 10)).rejects.toThrow(/entire mailbox/);
    expect(state.calls).toEqual([]);
  });

  it("does not report a total for a mailbox it refused to search", async () => {
    state.messages = makeMessages(500);
    await expect(searchMessages(CFG, "INBOX", {}, 10)).rejects.toThrow();
    expect(state.calls).toEqual([]);
  });
});

describe("anyOf combines with its AND siblings", () => {
  it("keeps sibling fields when anyOf has exactly one alternative", () => {
    const query = buildSearchQuery({ from: "alice@x.com", anyOf: [{ subject: "invoice" }] });
    expect(query.from).toBe("alice@x.com");
    expect(query.or).toEqual([{ subject: "invoice" }]);
  });

  it("does not let a one-element anyOf overwrite a same-named sibling", () => {
    const query = buildSearchQuery({ from: "alice@x.com", anyOf: [{ from: "bob@x.com" }] });
    expect(query.from).toBe("alice@x.com");
    expect(query.or).toEqual([{ from: "bob@x.com" }]);
  });

  it("narrows, never widens, when a collapsed anyOf meets a date sibling", async () => {
    const cutoff = new Date(Date.UTC(2026, 0, 6));
    state.messages = makeMessages(10).map((m, i) => (
      i % 2 === 0 ? { ...m, from: { name: "No Reply", address: "noreply@x.com" } } : m
    ));
    const page = await searchMessages(CFG, "INBOX", { before: cutoff, anyOf: [{ from: "noreply@x.com" }] }, 50);
    // Before the cutoff AND from noreply — not everything before the cutoff.
    expect(page.messages.map((m) => m.subject)).toEqual(["Message 1", "Message 3", "Message 5"]);
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

  it("stops pulling bytes off the wire at the cap instead of buffering the whole part", async () => {
    // A 30MB part offered lazily. Without the byte cap every chunk is read
    // into memory; with it, only enough to fill BODY_BYTE_LIMIT.
    const CHUNK = 1_000_000;
    let chunksServed = 0;
    state.messages = makeMessages(1, {
      bodyStructure: plainStructure,
      parts: {
        "1": {
          charset: "utf-8",
          chunks: function* () {
            for (let i = 0; i < 30; i++) {
              chunksServed++;
              yield Buffer.alloc(CHUNK, "x");
            }
          },
        },
      },
    });
    const body = await fetchBody(CFG, "INBOX", 1000);
    expect(body.truncated).toBe(true);
    expect(body.body.length).toBe(BODY_CHAR_LIMIT);
    expect(chunksServed).toBeLessThanOrEqual(Math.ceil(BODY_BYTE_LIMIT / CHUNK) + 1);
    expect(chunksServed).toBeLessThan(30);
  });

  it("decodes a latin-1 part with its declared charset, not as utf-8", async () => {
    state.messages = makeMessages(1, {
      bodyStructure: { ...plainStructure, parameters: { charset: "iso-8859-1" } },
      parts: {
        "1": {
          charset: "iso-8859-1",
          // Raw latin-1 bytes: "Café münü" — 0xE9/0xFC are invalid UTF-8 alone.
          chunks: () => [Buffer.from("Café münü", "latin1")],
        },
      },
    });
    const body = await fetchBody(CFG, "INBOX", 1000);
    expect(body.body).toBe("Café münü");
    expect(body.body).not.toContain("�");
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

  // The body result carries the text in full; a `snippet` field here could
  // only be populated by fetching the whole raw message beside it, and used to
  // be an always-empty string that the type claimed was a preview.
  it("carries no snippet field to be empty", async () => {
    state.messages = makeMessages(1, {
      bodyStructure: plainStructure,
      parts: { "1": { text: "the whole body" } },
    });
    const body = await fetchBody(CFG, "INBOX", 1000);
    expect("snippet" in body).toBe(false);
    expect(body.body).toBe("the whole body");
    expect(body.subject).toBe("Message 1");
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
    expect(result).toEqual({ requested: 2, moved: 2, confirmed: true, destination: "[Gmail]/Trash" });
    expect(state.moves).toEqual([{ uids: [1000, 1002], destination: "[Gmail]/Trash" }]);
  });

  it("reports zero — not success — when the server refuses the move", async () => {
    state.messages = makeMessages(3);
    state.moveResult = false;
    const result = await moveMessages(CFG, "INBOX", [1000, 1002], "[Gmail]/Trash");
    expect(result).toMatchObject({ requested: 2, moved: 0, confirmed: true });
  });

  it("counts what the server confirmed, not what was asked, when they differ", async () => {
    state.messages = makeMessages(3);
    state.moveResult = { uidMap: new Map([[1000, 9000]]) };
    const result = await moveMessages(CFG, "INBOX", [1000, 1001, 1002], "[Gmail]/Trash");
    expect(result.requested).toBe(3);
    expect(result.moved).toBe(1);
    expect(result.confirmed).toBe(true);
  });

  it("says so when a server without UIDPLUS confirms nothing", async () => {
    state.messages = makeMessages(3);
    state.moveResult = { path: "INBOX", destination: "Trash" };
    const result = await moveMessages(CFG, "INBOX", [1000, 1001], "Trash");
    expect(result).toMatchObject({ requested: 2, moved: 2, confirmed: false });
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

  // Asserting "the fake was never asked to expunge" against a fake that has no
  // expunge method can never fail. The invariant is about the SOURCE, so the
  // check reads the source: if anyone ever implements permanent deletion in
  // this module family, this fails on the commit that does it.
  it("never expunges — deletion is a move (decision E1)", async () => {
    const { readFileSync, readdirSync } = await import("node:fs");
    const dir = new URL(".", import.meta.url);
    const files = readdirSync(dir).filter((f) => /^email-.*\.ts$/.test(f) && !f.endsWith(".test.ts"));
    expect(files.length).toBeGreaterThanOrEqual(3);
    const offenders: string[] = [];
    for (const file of files) {
      const source = readFileSync(new URL(file, dir), "utf-8")
        // Prose may DISCUSS expunge — the module header explains why it is
        // absent. Only code counts.
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/^[ \t]*\/\/.*$/gm, "");
      if (/\bexpunge\b|messageDelete|\\\\Deleted/i.test(source)) offenders.push(file);
    }
    expect(offenders).toEqual([]);
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

/**
 * A SESSION is the same lifecycle with more than one operation inside it. The
 * per-operation exports above are this with exactly one call, so everything
 * pinned there has to survive here — a leaked connection is worse than a slow
 * one, and this is the shape that can leak.
 */
describe("withSession — several operations, one connection", () => {
  it("connects once, locks per operation, and tears down once", async () => {
    // MUTATION: open a connection per operation (the old shape) — three
    // connects and three logouts appear.
    state.messages = makeMessages(3);
    state.folders = [{ path: "INBOX", name: "INBOX", subscribed: true }];
    const seen = await withSession(CFG, async (session) => {
      const folders = await session.listFolders();
      const page = await session.fetchMessages("INBOX", null, 10);
      const moved = await session.moveMessages("INBOX", [1000], "Trash");
      return { folders: folders.length, returned: page.returned, moved: moved.moved };
    });
    expect(seen, "the session did not actually do the three operations").toEqual({ folders: 1, returned: 3, moved: 1 });
    expect(state.calls).toEqual([
      "construct", "connect", "list",
      "lock:INBOX", "fetch", "release",
      "lock:INBOX", "move", "release",
      "logout", "close",
    ]);
  });

  it("closes the connection when an operation inside the session throws", async () => {
    state.messages = makeMessages(2);
    state.failFetch = true;
    await expect(withSession(CFG, async (session) => {
      await session.fetchMessages("INBOX", null, 10);
    })).rejects.toThrow(/fetch exploded/);
    expect(state.calls.filter((c) => c === "close"), "a failed session leaked its connection").toHaveLength(1);
    expect(state.calls.filter((c) => c === "release"), "the lock was not released on the error path").toHaveLength(1);
  });

  it("closes the socket exactly once when connecting fails, and does not retry", async () => {
    // Two operations, one failed handshake: the rejected connection is
    // remembered, so the second operation does not dial again and the teardown
    // does not close a socket the failure path already closed.
    state.failConnect = true;
    await expect(withSession(CFG, async (session) => {
      await session.listFolders().catch(() => {});
      await session.listFolders();
    })).rejects.toThrow(/connect refused/);
    expect(state.calls).toEqual(["construct", "connect", "close"]);
  });

  it("opens NOTHING for a session whose operations all refuse from their arguments", async () => {
    // The property `email_delete`'s cheap refusals rest on: a session that never
    // needs the server never pays for one. MUTATION: connect eagerly in
    // withSession — this becomes ["construct","connect","logout","close"].
    const out = await withSession(CFG, async (session) => {
      const moved = await session.moveMessages("INBOX", [], "Trash");
      const headers = await session.fetchHeaders("INBOX", []);
      const flagged = await session.setFlags("INBOX", [], ["\\Seen"], "add");
      return { moved: moved.moved, headers: headers.length, updated: flagged.updated };
    });
    expect(out).toEqual({ moved: 0, headers: 0, updated: 0 });
    expect(state.calls, "a session that needed no server still dialled one").toEqual([]);
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

  // C2 is told "content is the serialized EmailPage". That has to hold on the
  // empty path too, and the metadata key set must not vary with the outcome.
  it("email_read returns a parseable empty page rather than a sentence", async () => {
    state.messages = makeMessages(2).map((m) => ({ ...m, seen: true }));
    const result = await emailRead.execute({ unread_only: true });
    expect(result.isError).toBeFalsy();
    expect(JSON.parse(String(result.content))).toEqual({ messages: [], total: 0, returned: 0, truncated: false });
  });

  it("reports the same metadata keys whether or not anything matched", async () => {
    state.messages = makeMessages(2).map((m) => ({ ...m, seen: true }));
    const empty = await emailRead.execute({ unread_only: true });
    state.reset();
    state.messages = makeMessages(2);
    const full = await emailRead.execute({ limit: 10 });
    expect(Object.keys(empty.metadata ?? {}).sort()).toEqual(["count", "total", "truncated"]);
    expect(Object.keys(full.metadata ?? {}).sort()).toEqual(Object.keys(empty.metadata ?? {}).sort());
    expect(empty.metadata).toMatchObject({ count: 0, total: 0, truncated: false });
  });

  it("email_search refuses an empty query instead of returning the mailbox", async () => {
    state.messages = makeMessages(500);
    const result = await emailSearch.execute({ query: "" });
    expect(result.isError).toBe(true);
    expect(state.calls).toEqual([]);
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
