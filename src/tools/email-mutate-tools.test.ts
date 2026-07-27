/**
 * Behaviour of `email_delete` and `email_mark`, driven against a fake ImapFlow.
 *
 * The fake records every IMAP verb it is asked for, so the invariants that
 * matter here are checkable as OBSERVATIONS rather than as claims: which folder
 * was selected, what was moved where FROM WHERE, which flags were set - and, on
 * the delete path, the fact that no permanent-removal verb was ever issued.
 *
 * The fake models three things it used to fake away. Each of them hid a real
 * defect for a whole review cycle, so they are stated here rather than left as
 * reading exercises:
 *
 *  1. MESSAGES ARE KEYED BY FOLDER. IMAP uids are per-mailbox. The old fake
 *     held ONE global list, so it could not represent uid 1000 meaning
 *     different messages in INBOX and in `receipts` - which made every "acts on
 *     exactly the enumerated set" assertion silent about WHICH folder the set
 *     came from, and let a delete that moved the wrong messages pass 30 tests.
 *  2. SEARCH HONOURS ITS QUERY. The old `search(_query)` returned everything,
 *     so a predicate dropped between the tool and `buildSearchQuery` was
 *     undetectable here: a date window silently discarded would still have
 *     "matched" the same messages.
 *  3. MOVES CAN PARTIALLY SUCCEED. The old `messageMove` always returned a
 *     uidMap covering every requested uid, so `moved: 1 of 3` had no test.
 *
 * Fail-first: every block below was run against the pre-C3 tree (where the tools
 * do not exist) and against the mutations named inline.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

interface FakeFolder { path: string; name: string; specialUse?: string; subscribed: boolean }
interface FakeMessage { uid: number; from: string; subject: string; date: Date; seen: boolean; body: string }

const h = vi.hoisted(() => {
  interface Msg { uid: number; from: string; subject: string; date: Date; seen: boolean; body: string }
  type Query = Record<string, unknown>;

  /** The subset of imapflow's SearchObject the email tools can produce, applied
   *  the way a server would: AND across fields, OR across `or`. Substring
   *  matching mirrors IMAP's SEARCH, which is a containment test, not equality. */
  function matches(msg: Msg, q: Query): boolean {
    const has = (hay: string, needle: unknown) => hay.toLowerCase().includes(String(needle).toLowerCase());
    if (q.from !== undefined && !has(msg.from, q.from)) return false;
    if (q.subject !== undefined && !has(msg.subject, q.subject)) return false;
    if (q.body !== undefined && !has(msg.body, q.body)) return false;
    if (q.text !== undefined && !has(`${msg.from} ${msg.subject} ${msg.body}`, q.text)) return false;
    if (q.seen !== undefined && msg.seen !== q.seen) return false;
    if (q.before instanceof Date && !(msg.date < q.before)) return false;
    if (q.since instanceof Date && !(msg.date >= q.since)) return false;
    if (Array.isArray(q.or) && !q.or.some((alt) => matches(msg, alt as Query))) return false;
    return true;
  }

  const state = {
    folders: [] as FakeFolder[],
    /** Messages KEYED BY FOLDER path - the whole point of the rewrite. */
    mailbox: {} as Record<string, Msg[]>,
    /** Folders that exist in LIST but refuse SELECT - Gmail's "[Gmail]" node. */
    unselectable: [] as string[],
    /** false = the server refuses the move outright. */
    moveAccepted: true,
    /** false = accepted, but no UIDPLUS map, so nothing is enumerated. */
    moveEnumerated: true,
    /** null = the whole requested set moves; N = only the first N of the uids
     *  that are actually present do, which is a genuine partial success. */
    movePartial: null as number | null,
    flagsAccepted: true,
    /** Refuse only these flag actions - how a half-applied mark is reached. */
    refuseFlagActions: [] as string[],
    calls: [] as string[],
    searchQueries: [] as Query[],
    moves: [] as { source: string; uids: number[]; destination: string }[],
    flagOps: [] as { folder: string; uids: number[]; flags: string[]; action: string }[],
    reset(): void {
      state.folders = [];
      state.mailbox = {};
      state.unselectable = [];
      state.moveAccepted = true;
      state.moveEnumerated = true;
      state.movePartial = null;
      state.flagsAccepted = true;
      state.refuseFlagActions = [];
      state.calls = [];
      state.searchQueries = [];
      state.moves = [];
      state.flagOps = [];
    },
  };

  class FakeImapFlow {
    mailbox: { exists: number } | undefined;
    /** Which folder is SELECTed. Every uid-taking verb below is scoped to it,
     *  exactly as a real server scopes uids to the selected mailbox. */
    selected = "";
    constructor(_opts: unknown) { state.calls.push("construct"); }
    private here(): Msg[] { return state.mailbox[this.selected] ??= []; }
    async connect(): Promise<void> { state.calls.push("connect"); }
    async logout(): Promise<void> { state.calls.push("logout"); }
    close(): void { state.calls.push("close"); }
    async list(): Promise<unknown[]> { state.calls.push("list"); return state.folders; }
    async getMailboxLock(path: string): Promise<{ release: () => void }> {
      state.calls.push(`lock:${path}`);
      if (state.unselectable.includes(path)) throw new Error(`Mailbox ${path} does not exist or cannot be selected`);
      this.selected = path;
      this.mailbox = { exists: this.here().length };
      return { release: () => state.calls.push("release") };
    }
    async search(query: Query): Promise<number[]> {
      state.calls.push("search");
      state.searchQueries.push(query);
      return this.here().filter((m) => matches(m, query)).map((m) => m.uid);
    }
    async *fetch(range: number[] | string, opts: { source?: boolean }): AsyncGenerator<unknown> {
      state.calls.push("fetch");
      const here = this.here();
      let chosen: Msg[];
      if (Array.isArray(range)) {
        chosen = here.filter((m) => range.includes(m.uid));
      } else if (typeof range === "string") {
        // A SEQUENCE range ("3:7"), 1-indexed positions in the selected folder.
        const [lo, hi] = range.split(":");
        const end = hi === "*" ? here.length : Number(hi);
        chosen = here.slice(Math.max(0, Number(lo) - 1), end);
      } else {
        chosen = here;
      }
      for (const m of chosen) {
        yield {
          uid: m.uid,
          envelope: { from: [{ address: m.from }], subject: m.subject, date: m.date, messageId: `<${m.uid}@x>` },
          ...(opts?.source ? { source: Buffer.from(`Subject: ${m.subject}\r\n\r\n${m.body}`) } : {}),
        };
      }
    }
    async messageMove(uids: number[], destination: string): Promise<unknown> {
      state.calls.push("move");
      state.moves.push({ source: this.selected, uids, destination });
      if (!state.moveAccepted) return false;
      const here = this.here();
      // Only uids actually IN the selected folder can move, and a partial
      // server moves a prefix of them.
      const present = uids.filter((u) => here.some((m) => m.uid === u));
      const actually = state.movePartial === null ? present : present.slice(0, state.movePartial);
      const leaving = here.filter((m) => actually.includes(m.uid));
      state.mailbox[this.selected] = here.filter((m) => !actually.includes(m.uid));
      (state.mailbox[destination] ??= []).push(...leaving);
      if (!state.moveEnumerated) return {};
      return { uidMap: new Map(actually.map((u, i) => [u, 9000 + i])) };
    }
    private applyFlags(uids: number[], flags: string[], action: "add" | "remove"): boolean {
      state.calls.push(`flags:${action}`);
      state.flagOps.push({ folder: this.selected, uids, flags, action });
      const ok = state.flagsAccepted && !state.refuseFlagActions.includes(action);
      if (ok && flags.includes("\\Seen")) {
        for (const m of this.here()) if (uids.includes(m.uid)) m.seen = action === "add";
      }
      return ok;
    }
    async messageFlagsAdd(uids: number[], flags: string[]): Promise<boolean> {
      return this.applyFlags(uids, flags, "add");
    }
    async messageFlagsRemove(uids: number[], flags: string[]): Promise<boolean> {
      return this.applyFlags(uids, flags, "remove");
    }
  }

  return { state, FakeImapFlow };
});

vi.mock("imapflow", () => ({ ImapFlow: h.FakeImapFlow }));

const state = h.state;

const { emailDelete, emailMark } = await import("./email-mutate-tools.js");

const IMAP_ENV = ["IMAP_HOST", "IMAP_USER", "IMAP_PASS", "IMAP_PORT"];
let saved: Record<string, string | undefined>;
let dataDir: string;

/** A provider that calls its trash "Bin" and hangs it off a vendor prefix -
 *  deliberately, so nothing here can pass by matching the string "Trash". */
const GMAIL: FakeFolder[] = [
  { path: "INBOX", name: "INBOX", subscribed: true },
  { path: "[Gmail]", name: "[Gmail]", subscribed: false },
  { path: "[Gmail]/All Mail", name: "All Mail", specialUse: "\\All", subscribed: true },
  { path: "[Gmail]/Bin", name: "Bin", specialUse: "\\Trash", subscribed: true },
  { path: "receipts", name: "receipts", subscribed: true },
];

/** A different provider: a differently-named trash under a dotted namespace. */
const DOVECOT: FakeFolder[] = [
  { path: "INBOX", name: "INBOX", subscribed: true },
  { path: "INBOX.Papierkorb", name: "Papierkorb", specialUse: "\\Trash", subscribed: true },
];

function messages(n: number, from = "noreply@example.com", startUid = 1000): FakeMessage[] {
  return Array.from({ length: n }, (_, i) => ({
    uid: startUid + i,
    from,
    subject: `Message ${i}`,
    date: new Date("2026-01-01T00:00:00Z"),
    seen: false,
    body: "body",
  }));
}

/** Which uids are sitting in a folder right now. */
function inFolder(path: string): number[] {
  return (state.mailbox[path] ?? []).map((m) => m.uid);
}

beforeEach(() => {
  state.reset();
  saved = Object.fromEntries([...IMAP_ENV, "LAX_DATA_DIR"].map((k) => [k, process.env[k]]));
  dataDir = mkdtempSync(join(tmpdir(), "email-mutate-"));
  process.env.LAX_DATA_DIR = dataDir;
  process.env.IMAP_HOST = "imap.example.com";
  process.env.IMAP_USER = "me@example.com";
  process.env.IMAP_PASS = "secret";
});

afterEach(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  rmSync(dataDir, { recursive: true, force: true });
});

async function del(args: Record<string, unknown>) {
  const result = await emailDelete.execute(args);
  return { result, payload: result.isError ? null : JSON.parse(String(result.content)) };
}

describe("email_delete - deletion is a move to Trash, resolved by role", () => {
  it("moves the matched messages into the folder whose specialUse is \\Trash", async () => {
    state.folders = GMAIL;
    state.mailbox = { INBOX: messages(3) };
    const { result, payload } = await del({ from: "noreply@example.com" });
    expect(result.isError).toBeFalsy();
    expect(state.moves).toEqual([{ source: "INBOX", uids: [1000, 1001, 1002], destination: "[Gmail]/Bin" }]);
    expect(payload.destination).toBe("[Gmail]/Bin");
    expect(payload.moved).toBe(3);
    expect(inFolder("[Gmail]/Bin")).toEqual([1000, 1001, 1002]);
    expect(inFolder("INBOX")).toEqual([]);
  });

  it("works on a provider whose trash is named nothing like 'Trash'", async () => {
    // MUTATION: resolve the destination by name (/trash/i) or by hardcoding
    // "[Gmail]/Trash". Both find nothing here and either fail or, worse, create
    // a folder - on the single most common non-Gmail server family.
    state.folders = DOVECOT;
    state.mailbox = { INBOX: messages(2) };
    await del({ from: "noreply@example.com" });
    expect(state.moves[0].destination).toBe("INBOX.Papierkorb");
  });

  it("NEVER issues a permanent-removal verb - no flag-and-purge path exists", async () => {
    // The companion to the SOURCE assertion in email-imap.test.ts: that one
    // proves the code cannot contain such a call, this one proves the code path
    // a delete actually walks issues only move. MUTATION: swap moveMessages for
    // a flag-based delete - `moves` empties and a flag op appears.
    state.folders = GMAIL;
    state.mailbox = { INBOX: messages(2) };
    await del({ from: "noreply@example.com" });
    expect(state.flagOps).toEqual([]);
    expect(state.calls).toContain("move");
    expect(state.calls.filter((c) => /purge|delete|store/i.test(c))).toEqual([]);
  });

  it("fails LOUDLY when no folder carries the \\Trash role, and moves nothing", async () => {
    // MUTATION: fall back to a name guess, or to flagging. Either invents a
    // destructive behaviour the user never agreed to on an account we cannot
    // read the layout of.
    state.folders = [{ path: "INBOX", name: "INBOX", subscribed: true }];
    state.mailbox = { INBOX: messages(2) };
    const { result } = await del({ from: "noreply@example.com" });
    expect(result.isError).toBe(true);
    expect(String(result.content)).toMatch(/does not advertise a Trash folder/i);
    expect(state.moves).toEqual([]);
  });

  it("refuses to 'delete' from Trash itself rather than pretending to purge", async () => {
    state.folders = GMAIL;
    state.mailbox = { "[Gmail]/Bin": messages(2) };
    const { result } = await del({ folder: "[Gmail]/Bin", from: "noreply@example.com" });
    expect(result.isError).toBe(true);
    expect(String(result.content)).toMatch(/already deleted/i);
    expect(state.moves).toEqual([]);
  });
});

describe("email_delete - uids are resolved in the folder being moved FROM", () => {
  /** INBOX and `receipts` both number their mail from 1000. That is not a
   *  contrived collision: IMAP assigns uids per mailbox, so it is the normal
   *  case for two folders of similar age. */
  function collidingMailbox() {
    return {
      INBOX: messages(3, "bank@example.com"),
      receipts: messages(2, "shop@example.com"),
    };
  }

  it("refuses a uid list with no folder rather than assuming INBOX", async () => {
    // THE REPORTED FAILURE, at its root. A model that searched `receipts`, got
    // [1000, 1001] and called email_delete({uids}) moved INBOX's 1000 and 1001
    // - real mail from a different sender - and got back "moved": 2,
    // "confirmed": true. An existence check cannot catch it: both folders
    // number from 1000, so the uids ARE present in INBOX. Nothing downstream
    // knows where the uids came from either, so the silent default is the only
    // place the class can be closed. MUTATION: restore `|| "INBOX"` for the uid
    // path - the delete below succeeds against the wrong messages again.
    state.folders = GMAIL;
    state.mailbox = collidingMailbox();
    const { result } = await del({ uids: [1000, 1001] });
    expect(result.isError).toBe(true);
    expect(String(result.content)).toMatch(/`uids` needs `folder`/);
    expect(String(result.content)).toMatch(/will not assume INBOX/);
    expect(state.moves).toEqual([]);
    expect(inFolder("INBOX")).toEqual([1000, 1001, 1002]);
    expect(inFolder("receipts")).toEqual([1000, 1001]);
  });

  it("still defaults to INBOX for the filter path, where the uids are its own", async () => {
    // The requirement is about uids a CALLER supplies. Filters resolve their
    // own uids inside the folder being searched, so there is no provenance to
    // lose and no reason to make the common case harder.
    state.folders = GMAIL;
    state.mailbox = collidingMailbox();
    const { result, payload } = await del({ from: "bank@example.com" });
    expect(result.isError).toBeFalsy();
    expect(payload.source).toBe("INBOX");
  });

  it("refuses uids that are not in the folder, naming them, and moves nothing", async () => {
    // THE BUG THIS ITEM EXISTS FOR, in its detectable half: `uids` used to go
    // straight to moveMessages with no existence check, so a uid that is not
    // there came back as a NON-ERROR payload saying the number moved was
    // "UNKNOWN" - a delete of a message that does not exist, reported as a
    // possible success. MUTATION: drop the fetchHeaders resolve - this returns
    // a non-error payload with confirmed:false instead of refusing.
    state.folders = GMAIL;
    state.mailbox = { INBOX: messages(3) };
    const { result } = await del({ folder: "INBOX", uids: [5555] });
    expect(result.isError).toBe(true);
    expect(String(result.content)).toContain("5555");
    expect(String(result.content)).toMatch(/not in "INBOX"/);
    expect(String(result.content)).toMatch(/uids are per-folder/i);
    expect(state.moves).toEqual([]);
  });

  it("refuses the WHOLE call when only some uids are absent - no partial delete", async () => {
    state.folders = GMAIL;
    state.mailbox = { INBOX: messages(2) };
    const { result } = await del({ folder: "INBOX", uids: [1000, 1001, 4242] });
    expect(result.isError).toBe(true);
    expect(String(result.content)).toContain("4242");
    expect(state.moves).toEqual([]);
    expect(inFolder("INBOX")).toEqual([1000, 1001]);
  });

  it("resolves uids in the NAMED folder, not in INBOX", async () => {
    // uid 1002 exists in INBOX and not in receipts. A resolve that checked the
    // default folder instead of the requested one would wave it through.
    state.folders = GMAIL;
    state.mailbox = collidingMailbox();
    const { result } = await del({ folder: "receipts", uids: [1000, 1002] });
    expect(result.isError).toBe(true);
    expect(String(result.content)).toContain("1002");
    expect(state.moves).toEqual([]);
  });

  it("moves from the folder named, leaving the same uids in other folders alone", async () => {
    state.folders = GMAIL;
    state.mailbox = collidingMailbox();
    const { payload } = await del({ folder: "receipts", uids: [1000, 1001] });
    expect(state.moves).toEqual([{ source: "receipts", uids: [1000, 1001], destination: "[Gmail]/Bin" }]);
    expect(payload.source).toBe("receipts");
    expect(inFolder("receipts")).toEqual([]);
    expect(inFolder("INBOX")).toEqual([1000, 1001, 1002]);
  });

  it("names every message it moved, so a wrong-folder delete cannot be invisible", async () => {
    // The backstop behind the two refusals above. uids 1000/1001 exist in BOTH
    // folders, so if a caller names the WRONG folder confidently, nothing can
    // detect it - "moved: 2" is identical either way. Naming the sender and
    // subject of what actually moved makes a wrong-set delete visible in the
    // same breath as the claim of success, instead of only in the mailbox.
    // MUTATION: drop `messages` from the payload - the two folders become
    // indistinguishable in the result again.
    state.folders = GMAIL;
    state.mailbox = collidingMailbox();
    const { payload } = await del({ folder: "INBOX", uids: [1000, 1001] });
    expect(payload.moved).toBe(2);
    expect(payload.source).toBe("INBOX");
    expect(payload.messages).toEqual([
      { uid: 1000, from: "<bank@example.com>", subject: "Message 0", date: "2026-01-01T00:00:00.000Z" },
      { uid: 1001, from: "<bank@example.com>", subject: "Message 1", date: "2026-01-01T00:00:00.000Z" },
    ]);
  });

  it("names what the FILTER path moved too, not only the uid path", async () => {
    state.folders = GMAIL;
    state.mailbox = collidingMailbox();
    const { payload } = await del({ folder: "receipts", from: "shop@example.com" });
    expect(payload.messages.map((m: { from: string }) => m.from)).toEqual(["<shop@example.com>", "<shop@example.com>"]);
  });

  it("warns about per-folder uids in the parameter description a model reads", async () => {
    // The prose is the only thing standing between a model and the collision
    // case above, and this was the WEAKEST of the three uid-taking email tools
    // ("Folder to delete from (default: INBOX)") despite being the destructive
    // one. MUTATION: revert the description - this fails.
    const props = emailDelete.parameters.properties as Record<string, { description: string }>;
    expect(props.folder.description).toMatch(/uids belong to/i);
    expect(props.folder.description).toMatch(/REQUIRED whenever `uids` is given/);
    expect(props.folder.description).toMatch(/per folder/i);
    expect(props.uids.description).toMatch(/same folder/i);
  });
});

describe("email_delete - never acting on more than it enumerated", () => {
  it("moves NOTHING when the match set is larger than one call can act on", async () => {
    // The failure E3/E4 exist to prevent: 4,000 match, the page holds 50, and
    // the tool trashes 50 while reporting success. MUTATION: drop the
    // `page.truncated` branch - `moves` gains a 2-uid entry and the user is told
    // the delete worked.
    state.folders = GMAIL;
    state.mailbox = { INBOX: messages(4000) };
    const { result } = await del({ from: "noreply@example.com", limit: 2 });
    expect(result.isError).toBe(true);
    expect(String(result.content)).toContain("4000");
    expect(String(result.content)).toMatch(/NOTHING was moved/);
    expect(state.moves).toEqual([]);
  });

  it("names both remedies - narrowing the filters and raising the limit", async () => {
    state.folders = GMAIL;
    state.mailbox = { INBOX: messages(300) };
    const { result } = await del({ from: "noreply@example.com" });
    expect(String(result.content)).toMatch(/narrow the filters/i);
    expect(String(result.content)).toMatch(/raise `limit` up to 200/);
  });

  it("caps `limit` at the batch ceiling instead of honouring an unbounded one", async () => {
    // MUTATION: pass `limit` through unclamped. `limit: 100000` would then make
    // a single unreviewable call able to empty a whole mailbox.
    state.folders = GMAIL;
    state.mailbox = { INBOX: messages(500) };
    const { result } = await del({ from: "noreply@example.com", limit: 100000 });
    expect(result.isError).toBe(true);
    expect(String(result.content)).toMatch(/at most 200/);
    expect(state.moves).toEqual([]);
  });

  it("refuses an explicit uid list longer than the ceiling", async () => {
    state.folders = GMAIL;
    const { result } = await del({ uids: Array.from({ length: 201 }, (_, i) => 1000 + i) });
    expect(result.isError).toBe(true);
    expect(String(result.content)).toMatch(/at most 200 per call/);
    expect(state.moves).toEqual([]);
  });

  it("acts on exactly the enumerated set when it fits", async () => {
    state.folders = GMAIL;
    state.mailbox = { INBOX: messages(5) };
    const { payload } = await del({ from: "noreply@example.com", limit: 10 });
    expect(payload.uids).toEqual([1000, 1001, 1002, 1003, 1004]);
    expect(payload.requested).toBe(5);
  });
});

describe("email_delete - the search actually filters", () => {
  it("moves only the messages the predicate matched, not the whole folder", async () => {
    // Undetectable before the fake honoured its query: a tool that dropped the
    // `from` predicate on the way to buildSearchQuery would have "matched" all
    // five either way. MUTATION: send `{}` instead of the criteria.
    state.folders = GMAIL;
    state.mailbox = { INBOX: [...messages(2, "bank@example.com", 1000), ...messages(3, "spam@example.com", 2000)] };
    const { payload } = await del({ from: "spam@example.com" });
    expect(payload.uids).toEqual([2000, 2001, 2002]);
    expect(inFolder("INBOX")).toEqual([1000, 1001]);
    expect(state.searchQueries).toEqual([{ from: "spam@example.com" }]);
  });

  it("compiles `query` into the OR of subject and sender, and moves only those", async () => {
    state.folders = GMAIL;
    state.mailbox = {
      INBOX: [
        { uid: 1000, from: "a@example.com", subject: "invoice 1", date: new Date("2026-01-01"), seen: false, body: "x" },
        { uid: 1001, from: "invoice@example.com", subject: "hello", date: new Date("2026-01-01"), seen: false, body: "x" },
        { uid: 1002, from: "b@example.com", subject: "newsletter", date: new Date("2026-01-01"), seen: false, body: "x" },
      ],
    };
    const { payload } = await del({ query: "invoice" });
    expect(payload.uids).toEqual([1000, 1001]);
    expect(inFolder("INBOX")).toEqual([1002]);
  });

  it("honours the date window rather than deleting every message from the sender", async () => {
    // The C2 rule with teeth: `before` reaching the server as a real predicate.
    state.folders = GMAIL;
    state.mailbox = {
      INBOX: [
        { uid: 1000, from: "noreply@example.com", subject: "old", date: new Date("2020-01-01"), seen: false, body: "x" },
        { uid: 1001, from: "noreply@example.com", subject: "new", date: new Date("2026-07-01"), seen: false, body: "x" },
      ],
    };
    const { payload } = await del({ from: "noreply@example.com", before: "2021-01-01" });
    expect(payload.uids).toEqual([1000]);
    expect(inFolder("INBOX")).toEqual([1001]);
  });

  it("honours unread_only", async () => {
    state.folders = GMAIL;
    const msgs = messages(2);
    msgs[0].seen = true;
    state.mailbox = { INBOX: msgs };
    const { payload } = await del({ unread_only: true });
    expect(payload.uids).toEqual([1001]);
  });
});

describe("email_delete - reporting what the server actually confirmed", () => {
  it("reports `moved` from the server's own enumeration", async () => {
    state.folders = GMAIL;
    state.mailbox = { INBOX: messages(3) };
    const { payload } = await del({ folder: "INBOX", uids: [1000, 1001, 1002] });
    expect(payload.confirmed).toBe(true);
    expect(payload.moved).toBe(3);
  });

  it("reports a genuine partial move as the partial it was", async () => {
    // Untestable before: the fake's uidMap always covered the whole request.
    // MUTATION: report `requested` as `moved` - this then says 3 of 3 while one
    // message moved, which is the over-report the whole chunk is about.
    state.folders = GMAIL;
    state.mailbox = { INBOX: messages(3) };
    state.movePartial = 1;
    const { result, payload } = await del({ folder: "INBOX", uids: [1000, 1001, 1002] });
    expect(result.isError).toBeFalsy();
    expect(payload.requested).toBe(3);
    expect(payload.moved).toBe(1);
    expect(payload.note).toMatch(/Moved 1 of 3/);
    expect(inFolder("[Gmail]/Bin")).toEqual([1000]);
    expect(inFolder("INBOX")).toEqual([1001, 1002]);
  });

  it("does NOT present an unconfirmed move as a receipt", async () => {
    // MUTATION: report `result.moved` regardless of `confirmed`. On a server
    // without UIDPLUS that number is only what we ASKED for, so a partial move
    // reads as a complete one - the over-report this campaign was sequenced to
    // prevent.
    state.folders = GMAIL;
    state.mailbox = { INBOX: messages(3) };
    state.moveEnumerated = false;
    const { result, payload } = await del({ folder: "INBOX", uids: [1000, 1001, 1002] });
    expect(result.isError).toBeFalsy();
    expect(payload.confirmed).toBe(false);
    expect(payload.moved).toBeNull();
    expect(payload.note).toMatch(/UNKNOWN/);
    expect(result.metadata?.moved).toBeNull();
  });

  it("reports a refused move as a failure, not as a quiet zero", async () => {
    state.folders = GMAIL;
    state.mailbox = { INBOX: messages(2) };
    state.moveAccepted = false;
    const { result } = await del({ folder: "INBOX", uids: [1000, 1001] });
    expect(result.isError).toBe(true);
    expect(String(result.content)).toMatch(/0 of 2/);
    expect(String(result.content)).toMatch(/Nothing was deleted/);
  });

  it("says plainly that nothing matched rather than reporting a successful delete", async () => {
    state.folders = GMAIL;
    state.mailbox = { INBOX: [] };
    const { result, payload } = await del({ from: "nobody@example.com" });
    expect(result.isError).toBeFalsy();
    expect(payload.matched).toBe(0);
    expect(payload.moved).toBe(0);
    expect(state.moves).toEqual([]);
  });
});

describe("email_delete - refusing ambiguous or unbounded requests", () => {
  it("surfaces the whole-mailbox refusal AS ITSELF, not as folder advice", async () => {
    // MUTATION: give the criteria a default (`{ all: true }`, or falling back to
    // fetchMessages). C1 made buildSearchQuery THROW on criteria that reduce to
    // nothing precisely because the verb downstream is this one.
    //
    // The negative assertions are the fix for a wrong message that a looser
    // `/entire mailbox/i` check waved through: the old classifier tested the
    // error TEXT with /mailbox|folder|select/i, C1's refusal contains
    // "mailbox", so the model was told it had picked a \Noselect container and
    // should retry against a different folder. Both claims false, and the
    // suggested repair actively wrong.
    state.folders = GMAIL;
    state.mailbox = { INBOX: messages(50) };
    const { result } = await del({});
    expect(result.isError).toBe(true);
    expect(String(result.content)).toMatch(/Empty search criteria/);
    expect(String(result.content)).toMatch(/Pass at least one predicate/);
    expect(String(result.content)).not.toMatch(/containers that hold other folders/);
    expect(String(result.content)).not.toMatch(/Could not open the folder/);
    expect(state.moves).toEqual([]);
  });

  it("refuses `uids` and search filters together rather than picking one", async () => {
    state.folders = GMAIL;
    state.mailbox = { INBOX: messages(3) };
    const { result } = await del({ uids: [1000], from: "noreply@example.com" });
    expect(result.isError).toBe(true);
    expect(String(result.content)).toMatch(/not both/);
    expect(state.moves).toEqual([]);
  });

  it("refuses an argument it cannot use instead of widening the match set", async () => {
    // The C2 rule, reaching the destructive verb: `before: <epoch ms>` used to
    // drop the date window silently, which here would mean deleting every
    // message from that sender instead of the old ones.
    state.folders = GMAIL;
    state.mailbox = { INBOX: messages(5) };
    const { result } = await del({ from: "noreply@example.com", before: 1785000000000 });
    expect(result.isError).toBe(true);
    expect(String(result.content)).toMatch(/`before` must be a string/);
    expect(state.moves).toEqual([]);
  });

  it("refuses a uid that is not a uid", async () => {
    state.folders = GMAIL;
    const { result } = await del({ uids: [1000, "latest"] });
    expect(result.isError).toBe(true);
    expect(String(result.content)).toMatch(/positive whole-number message UIDs/);
    expect(state.moves).toEqual([]);
  });
});

describe("email_delete - folders that cannot be opened", () => {
  it("turns a SELECT failure into a clear error naming the folder", async () => {
    // listFolders drops box.flags (a C1 limitation), so \Noselect containers like
    // Gmail's "[Gmail]" are indistinguishable in the list. MUTATION: let the
    // throw escape - the model sees an unhandled imapflow message with no idea
    // that it picked a container. This is now classified by TYPE
    // (MailboxOpenError), so it still fires while the criteria refusal above no
    // longer does.
    state.folders = GMAIL;
    state.unselectable = ["[Gmail]"];
    const { result } = await del({ folder: "[Gmail]", uids: [1000] });
    expect(result.isError).toBe(true);
    expect(String(result.content)).toContain("[Gmail]");
    expect(String(result.content)).toMatch(/containers that hold other folders/);
    expect(state.moves).toEqual([]);
  });

  it("refuses a folder the account does not have, before any connection to move from it", async () => {
    state.folders = GMAIL;
    const { result } = await del({ folder: "Archiv", uids: [1000] });
    expect(result.isError).toBe(true);
    expect(String(result.content)).toMatch(/no folder named "Archiv"/);
    expect(state.moves).toEqual([]);
  });

  it("uses the server's spelling of a folder the caller mis-cased", async () => {
    state.folders = GMAIL;
    state.mailbox = { INBOX: messages(1) };
    await del({ folder: "inbox", uids: [1000] });
    expect(state.calls).toContain("lock:INBOX");
    expect(state.moves[0].source).toBe("INBOX");
  });
});

describe("email_mark", () => {
  it("adds \\Seen when asked to mark read", async () => {
    state.folders = GMAIL;
    state.mailbox = { INBOX: messages(2) };
    const result = await emailMark.execute({ uids: [1000, 1001], read: true, folder: "INBOX" });
    expect(result.isError).toBeFalsy();
    expect(state.flagOps).toEqual([{ folder: "INBOX", uids: [1000, 1001], flags: ["\\Seen"], action: "add" }]);
  });

  it("removes \\Seen when asked to mark unread", async () => {
    state.folders = GMAIL;
    state.mailbox = { INBOX: messages(1) };
    await emailMark.execute({ uids: [1000], read: false, folder: "INBOX" });
    expect(state.flagOps).toEqual([{ folder: "INBOX", uids: [1000], flags: ["\\Seen"], action: "remove" }]);
  });

  it("marks in the folder named, not in INBOX", async () => {
    state.folders = GMAIL;
    state.mailbox = { INBOX: messages(2), receipts: messages(2) };
    await emailMark.execute({ uids: [1000], read: true, folder: "receipts" });
    expect(state.flagOps).toEqual([{ folder: "receipts", uids: [1000], flags: ["\\Seen"], action: "add" }]);
    expect(state.mailbox.INBOX.map((m) => m.seen)).toEqual([false, false]);
    expect(state.mailbox.receipts.map((m) => m.seen)).toEqual([true, false]);
  });

  it("sets and clears the star in one call without disturbing the other flag", async () => {
    // MUTATION: read `starred` with the two-state reader. Absent would then mean
    // "false", so marking a message read would silently UNSTAR it.
    state.folders = GMAIL;
    state.mailbox = { INBOX: messages(1) };
    await emailMark.execute({ uids: [1000], read: true, starred: false, folder: "INBOX" });
    expect(state.flagOps).toEqual([
      { folder: "INBOX", uids: [1000], flags: ["\\Seen"], action: "add" },
      { folder: "INBOX", uids: [1000], flags: ["\\Flagged"], action: "remove" },
    ]);
    state.flagOps = [];
    await emailMark.execute({ uids: [1000], read: true, folder: "INBOX" });
    expect(state.flagOps).toEqual([{ folder: "INBOX", uids: [1000], flags: ["\\Seen"], action: "add" }]);
  });

  it("refuses a call that would change nothing", async () => {
    state.folders = GMAIL;
    const result = await emailMark.execute({ uids: [1000], folder: "INBOX" });
    expect(result.isError).toBe(true);
    expect(state.flagOps).toEqual([]);
  });

  it("refuses an empty uid set instead of reporting a successful no-op", async () => {
    state.folders = GMAIL;
    const result = await emailMark.execute({ uids: [], read: true });
    expect(result.isError).toBe(true);
    expect(state.flagOps).toEqual([]);
  });

  it("reports a refused flag change as a failure", async () => {
    state.folders = GMAIL;
    state.mailbox = { INBOX: messages(1) };
    state.flagsAccepted = false;
    const result = await emailMark.execute({ uids: [1000], read: true, folder: "INBOX" });
    expect(result.isError).toBe(true);
    expect(String(result.content)).toMatch(/refused/i);
    expect(String(result.content)).toMatch(/Nothing was changed/);
  });

  it("does NOT claim nothing changed when half the change landed", async () => {
    // THE ITEM 3 BUG: both round trips ran, the add was ACCEPTED - \Seen is set
    // on the server - and the refusal of the remove turned the whole call into
    // "Nothing was changed by those operations." The model then reports a failed
    // mark while the mailbox has moved. MUTATION: restore the blanket
    // "Nothing was changed by those operations" - the last three assertions fail.
    state.folders = GMAIL;
    state.mailbox = { INBOX: messages(1) };
    state.refuseFlagActions = ["remove"];
    const result = await emailMark.execute({ uids: [1000], read: true, starred: false, folder: "INBOX" });
    expect(state.mailbox.INBOX[0].seen).toBe(true);
    expect(result.isError).toBe(true);
    const text = String(result.content);
    expect(text).toMatch(/add \\Seen WAS applied/);
    expect(text).toMatch(/has NOT been rolled back/);
    expect(text).toMatch(/refused to remove \\Flagged/);
    expect(text).not.toMatch(/Nothing was changed/);
  });

  it("stops at the first refusal instead of issuing an op it expects to fail", async () => {
    // MUTATION: run both ops unconditionally - `flags:remove` reappears in the
    // call log, widening the half-applied window for no gain.
    state.folders = GMAIL;
    state.mailbox = { INBOX: messages(1) };
    state.refuseFlagActions = ["add"];
    const result = await emailMark.execute({ uids: [1000], read: true, starred: false, folder: "INBOX" });
    expect(result.isError).toBe(true);
    expect(state.calls.filter((c) => c.startsWith("flags:"))).toEqual(["flags:add"]);
    expect(String(result.content)).toMatch(/Nothing was changed/);
  });

  it("never moves anything", async () => {
    state.folders = GMAIL;
    state.mailbox = { INBOX: messages(1) };
    await emailMark.execute({ uids: [1000], read: true, starred: true, folder: "INBOX" });
    expect(state.moves).toEqual([]);
  });

  /* C7 PART 2 — the asymmetry C3's skeptic recorded, closed.
   *
   * email_mark was the last uid-taking mutating verb that silently defaulted
   * `folder` to INBOX. Same shape as the delete bug: a model that searched
   * `receipts`, got [1000, 1001] and called email_mark({uids, read:true}) marked
   * INBOX's 1000 and 1001 — different mail — and got a success payload naming
   * "INBOX", which reads as correct because INBOX is what it asked for. */
  it("refuses a uid list with no folder rather than assuming INBOX", async () => {
    // MUTATION: drop the requireExplicitFolder() call in emailMark.execute, or
    // restore `|| "INBOX"` as the only folder source — the flag op reappears
    // against INBOX's messages and `state.mailbox.INBOX[0].seen` flips.
    state.folders = GMAIL;
    state.mailbox = { INBOX: messages(2, "bank@example.com"), receipts: messages(2, "shop@example.com") };
    const result = await emailMark.execute({ uids: [1000, 1001], read: true });
    expect(result.isError).toBe(true);
    expect(String(result.content)).toMatch(/`uids` needs `folder`/);
    expect(String(result.content)).toMatch(/will not assume INBOX/);
    expect(state.flagOps, "a refused mark must not reach the server").toEqual([]);
    expect(state.mailbox.INBOX.map((m) => m.seen)).toEqual([false, false]);
    expect(state.mailbox.receipts.map((m) => m.seen)).toEqual([false, false]);
  });

  it("refuses before opening a connection, like every other pre-flight refusal", async () => {
    // A refusal that has already SELECTed a mailbox has done work on a target it
    // just said it would not act on.
    state.folders = GMAIL;
    state.mailbox = { INBOX: messages(1) };
    await emailMark.execute({ uids: [1000], read: true });
    expect(state.calls, "the folder refusal opened an IMAP connection first").toEqual([]);
  });

  it("declares `folder` required in the schema the model actually reads", () => {
    // The refusal and the schema have to agree: a required argument the schema
    // calls optional produces a tool the model calls wrong on the first try
    // every time, and learns nothing from because the description says otherwise.
    const params = emailMark.parameters as { required: string[]; properties: Record<string, { description: string }> };
    expect(params.required, "email_mark's schema still calls `folder` optional").toContain("folder");
    expect(params.properties.folder.description).toMatch(/REQUIRED/);
    expect(emailMark.description).toMatch(/PER FOLDER/);
  });
});

describe("both tools are hidden and inert without IMAP", () => {
  it("declares itself unavailable when IMAP is not configured", () => {
    delete process.env.IMAP_PASS;
    expect(emailDelete.available?.()).toBe(false);
    expect(emailMark.available?.()).toBe(false);
    process.env.IMAP_PASS = "secret";
    expect(emailDelete.available?.()).toBe(true);
    expect(emailMark.available?.()).toBe(true);
  });

  it("surfaces the configuration error without opening a connection", async () => {
    // MUTATION: connect first and report the failure afterwards. `available` is
    // advisory (a direct call still reaches execute), so the guard has to be
    // here too - and a destructive tool must not touch the network on a call it
    // is going to refuse anyway.
    delete process.env.IMAP_PASS;
    for (const tool of [emailDelete, emailMark]) {
      const result = await tool.execute({ uids: [1000], read: true });
      expect(result.isError).toBe(true);
      expect(String(result.content)).toMatch(/not configured/i);
    }
    expect(state.calls).toEqual([]);
  });
});
