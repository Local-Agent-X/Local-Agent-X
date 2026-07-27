/**
 * Behaviour of `email_delete` and `email_mark`, driven against a fake ImapFlow.
 *
 * The fake records every IMAP verb it is asked for, so the invariants that
 * matter here are checkable as OBSERVATIONS rather than as claims: which folder
 * was selected, what was moved where, which flags were set — and, on the delete
 * path, the fact that no permanent-removal verb was ever issued.
 *
 * Fail-first: every block below was run against the pre-C3 tree (where the tools
 * do not exist) and against the mutations named inline.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

interface FakeFolder { path: string; name: string; specialUse?: string; subscribed: boolean }
interface FakeMessage { uid: number; from: string; subject: string }

const h = vi.hoisted(() => {
  const state = {
    folders: [] as FakeFolder[],
    messages: [] as FakeMessage[],
    /** Folders that exist in LIST but refuse SELECT — Gmail's "[Gmail]" node. */
    unselectable: [] as string[],
    /** uids the server pretends to find; null = every message. */
    searchResult: null as number[] | null,
    /** false = the server refuses the move outright. */
    moveAccepted: true,
    /** false = accepted, but no UIDPLUS map, so nothing is enumerated. */
    moveEnumerated: true,
    flagsAccepted: true,
    calls: [] as string[],
    moves: [] as { uids: number[]; destination: string }[],
    flagOps: [] as { uids: number[]; flags: string[]; action: string }[],
    reset(): void {
      state.folders = [];
      state.messages = [];
      state.unselectable = [];
      state.searchResult = null;
      state.moveAccepted = true;
      state.moveEnumerated = true;
      state.flagsAccepted = true;
      state.calls = [];
      state.moves = [];
      state.flagOps = [];
    },
  };

  class FakeImapFlow {
    mailbox: { exists: number } | undefined;
    constructor(_opts: unknown) { state.calls.push("construct"); }
    async connect(): Promise<void> { state.calls.push("connect"); }
    async logout(): Promise<void> { state.calls.push("logout"); }
    close(): void { state.calls.push("close"); }
    async list(): Promise<unknown[]> { state.calls.push("list"); return state.folders; }
    async getMailboxLock(path: string): Promise<{ release: () => void }> {
      state.calls.push(`lock:${path}`);
      if (state.unselectable.includes(path)) throw new Error(`Mailbox ${path} does not exist or cannot be selected`);
      this.mailbox = { exists: state.messages.length };
      return { release: () => state.calls.push("release") };
    }
    async search(_query: unknown): Promise<number[]> {
      state.calls.push("search");
      return state.searchResult ?? state.messages.map((m) => m.uid);
    }
    async *fetch(range: number[] | string): AsyncGenerator<unknown> {
      state.calls.push("fetch");
      const wanted = Array.isArray(range) ? range : state.messages.map((m) => m.uid);
      for (const m of state.messages.filter((msg) => wanted.includes(msg.uid))) {
        yield {
          uid: m.uid,
          envelope: { from: [{ address: m.from }], subject: m.subject, date: new Date("2026-01-01T00:00:00Z"), messageId: `<${m.uid}@x>` },
          source: Buffer.from(`Subject: ${m.subject}\r\n\r\nbody`),
        };
      }
    }
    async messageMove(uids: number[], destination: string): Promise<unknown> {
      state.calls.push("move");
      state.moves.push({ uids, destination });
      if (!state.moveAccepted) return false;
      if (!state.moveEnumerated) return {};
      return { uidMap: new Map(uids.map((u, i) => [u, 9000 + i])) };
    }
    async messageFlagsAdd(uids: number[], flags: string[]): Promise<boolean> {
      state.calls.push("flags:add");
      state.flagOps.push({ uids, flags, action: "add" });
      return state.flagsAccepted;
    }
    async messageFlagsRemove(uids: number[], flags: string[]): Promise<boolean> {
      state.calls.push("flags:remove");
      state.flagOps.push({ uids, flags, action: "remove" });
      return state.flagsAccepted;
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

/** A provider that calls its trash "Bin" and hangs it off a vendor prefix —
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

function messages(n: number, from = "noreply@example.com"): FakeMessage[] {
  return Array.from({ length: n }, (_, i) => ({ uid: 1000 + i, from, subject: `Message ${i}` }));
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

describe("email_delete — deletion is a move to Trash, resolved by role", () => {
  it("moves the matched messages into the folder whose specialUse is \\Trash", async () => {
    state.folders = GMAIL;
    state.messages = messages(3);
    const { result, payload } = await del({ from: "noreply@example.com" });
    expect(result.isError).toBeFalsy();
    expect(state.moves).toEqual([{ uids: [1000, 1001, 1002], destination: "[Gmail]/Bin" }]);
    expect(payload.destination).toBe("[Gmail]/Bin");
    expect(payload.moved).toBe(3);
  });

  it("works on a provider whose trash is named nothing like 'Trash'", async () => {
    // MUTATION: resolve the destination by name (/trash/i) or by hardcoding
    // "[Gmail]/Trash". Both find nothing here and either fail or, worse, create
    // a folder — on the single most common non-Gmail server family.
    state.folders = DOVECOT;
    state.messages = messages(2);
    await del({ from: "noreply@example.com" });
    expect(state.moves[0].destination).toBe("INBOX.Papierkorb");
  });

  it("NEVER issues a permanent-removal verb — no flag-and-purge path exists", async () => {
    // The companion to the SOURCE assertion in email-imap.test.ts: that one
    // proves the code cannot contain such a call, this one proves the code path
    // a delete actually walks issues only move. MUTATION: swap moveMessages for
    // a flag-based delete — `moves` empties and a flag op appears.
    state.folders = GMAIL;
    state.messages = messages(2);
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
    state.messages = messages(2);
    const { result } = await del({ from: "noreply@example.com" });
    expect(result.isError).toBe(true);
    expect(String(result.content)).toMatch(/does not advertise a Trash folder/i);
    expect(state.moves).toEqual([]);
  });

  it("refuses to 'delete' from Trash itself rather than pretending to purge", async () => {
    state.folders = GMAIL;
    state.messages = messages(2);
    const { result } = await del({ folder: "[Gmail]/Bin", from: "noreply@example.com" });
    expect(result.isError).toBe(true);
    expect(String(result.content)).toMatch(/already deleted/i);
    expect(state.moves).toEqual([]);
  });
});

describe("email_delete — never acting on more than it enumerated", () => {
  it("moves NOTHING when the match set is larger than one call can act on", async () => {
    // The failure E3/E4 exist to prevent: 4,000 match, the page holds 50, and
    // the tool trashes 50 while reporting success. MUTATION: drop the
    // `page.truncated` branch — `moves` gains a 2-uid entry and the user is told
    // the delete worked.
    state.folders = GMAIL;
    state.messages = messages(4000);
    const { result } = await del({ from: "noreply@example.com", limit: 2 });
    expect(result.isError).toBe(true);
    expect(String(result.content)).toContain("4000");
    expect(String(result.content)).toMatch(/NOTHING was moved/);
    expect(state.moves).toEqual([]);
  });

  it("names both remedies — narrowing the filters and raising the limit", async () => {
    state.folders = GMAIL;
    state.messages = messages(300);
    const { result } = await del({ from: "noreply@example.com" });
    expect(String(result.content)).toMatch(/narrow the filters/i);
    expect(String(result.content)).toMatch(/raise `limit` up to 200/);
  });

  it("caps `limit` at the batch ceiling instead of honouring an unbounded one", async () => {
    // MUTATION: pass `limit` through unclamped. `limit: 100000` would then make
    // a single unreviewable call able to empty a whole mailbox.
    state.folders = GMAIL;
    state.messages = messages(500);
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
    state.messages = messages(5);
    const { payload } = await del({ from: "noreply@example.com", limit: 10 });
    expect(payload.uids).toEqual([1000, 1001, 1002, 1003, 1004]);
    expect(payload.requested).toBe(5);
  });
});

describe("email_delete — reporting what the server actually confirmed", () => {
  it("reports `moved` from the server's own enumeration", async () => {
    state.folders = GMAIL;
    state.messages = messages(3);
    const { payload } = await del({ uids: [1000, 1001, 1002] });
    expect(payload.confirmed).toBe(true);
    expect(payload.moved).toBe(3);
  });

  it("does NOT present an unconfirmed move as a receipt", async () => {
    // MUTATION: report `result.moved` regardless of `confirmed`. On a server
    // without UIDPLUS that number is only what we ASKED for, so a partial move
    // reads as a complete one — the over-report this campaign was sequenced to
    // prevent.
    state.folders = GMAIL;
    state.messages = messages(3);
    state.moveEnumerated = false;
    const { result, payload } = await del({ uids: [1000, 1001, 1002] });
    expect(result.isError).toBeFalsy();
    expect(payload.confirmed).toBe(false);
    expect(payload.moved).toBeNull();
    expect(payload.note).toMatch(/UNKNOWN/);
    expect(result.metadata?.moved).toBeNull();
  });

  it("reports a refused move as a failure, not as a quiet zero", async () => {
    state.folders = GMAIL;
    state.messages = messages(2);
    state.moveAccepted = false;
    const { result } = await del({ uids: [1000, 1001] });
    expect(result.isError).toBe(true);
    expect(String(result.content)).toMatch(/0 of 2/);
    expect(String(result.content)).toMatch(/Nothing was deleted/);
  });

  it("says plainly that nothing matched rather than reporting a successful delete", async () => {
    state.folders = GMAIL;
    state.messages = [];
    state.searchResult = [];
    const { result, payload } = await del({ from: "nobody@example.com" });
    expect(result.isError).toBeFalsy();
    expect(payload.matched).toBe(0);
    expect(payload.moved).toBe(0);
    expect(state.moves).toEqual([]);
  });
});

describe("email_delete — refusing ambiguous or unbounded requests", () => {
  it("surfaces the whole-mailbox refusal instead of deleting everything", async () => {
    // MUTATION: give the criteria a default (`{ all: true }`, or falling back to
    // fetchMessages). C1 made buildSearchQuery THROW on criteria that reduce to
    // nothing precisely because the verb downstream is this one.
    state.folders = GMAIL;
    state.messages = messages(50);
    const { result } = await del({});
    expect(result.isError).toBe(true);
    expect(String(result.content)).toMatch(/entire mailbox/i);
    expect(state.moves).toEqual([]);
  });

  it("refuses `uids` and search filters together rather than picking one", async () => {
    state.folders = GMAIL;
    state.messages = messages(3);
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
    state.messages = messages(5);
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

describe("email_delete — folders that cannot be opened", () => {
  it("turns a SELECT failure into a clear error naming the folder", async () => {
    // listFolders drops box.flags (a C1 limitation), so \Noselect containers like
    // Gmail's "[Gmail]" are indistinguishable in the list. MUTATION: let the
    // throw escape — the model sees an unhandled imapflow message with no idea
    // that it picked a container.
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
    state.messages = messages(1);
    await del({ folder: "inbox", uids: [1000] });
    expect(state.calls).toContain("lock:INBOX");
  });
});

describe("email_mark", () => {
  it("adds \\Seen when asked to mark read", async () => {
    state.folders = GMAIL;
    const result = await emailMark.execute({ uids: [1000, 1001], read: true });
    expect(result.isError).toBeFalsy();
    expect(state.flagOps).toEqual([{ uids: [1000, 1001], flags: ["\\Seen"], action: "add" }]);
  });

  it("removes \\Seen when asked to mark unread", async () => {
    state.folders = GMAIL;
    await emailMark.execute({ uids: [1000], read: false });
    expect(state.flagOps).toEqual([{ uids: [1000], flags: ["\\Seen"], action: "remove" }]);
  });

  it("sets and clears the star in one call without disturbing the other flag", async () => {
    // MUTATION: read `starred` with the two-state reader. Absent would then mean
    // "false", so marking a message read would silently UNSTAR it.
    state.folders = GMAIL;
    await emailMark.execute({ uids: [1000], read: true, starred: false });
    expect(state.flagOps).toEqual([
      { uids: [1000], flags: ["\\Seen"], action: "add" },
      { uids: [1000], flags: ["\\Flagged"], action: "remove" },
    ]);
    state.flagOps = [];
    await emailMark.execute({ uids: [1000], read: true });
    expect(state.flagOps).toEqual([{ uids: [1000], flags: ["\\Seen"], action: "add" }]);
  });

  it("refuses a call that would change nothing", async () => {
    state.folders = GMAIL;
    const result = await emailMark.execute({ uids: [1000] });
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
    state.flagsAccepted = false;
    const result = await emailMark.execute({ uids: [1000], read: true });
    expect(result.isError).toBe(true);
    expect(String(result.content)).toMatch(/refused/i);
  });

  it("never moves anything", async () => {
    state.folders = GMAIL;
    await emailMark.execute({ uids: [1000], read: true, starred: true });
    expect(state.moves).toEqual([]);
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
    // here too — and a destructive tool must not touch the network on a call it
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
