/** SKEPTIC-OWNED fake. Independent of email-mutate-tools.test.ts. */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const h = vi.hoisted(() => {
  interface Msg { uid: number; from: string; subject: string; date: Date; seen: boolean; body: string }
  /** Per-move-call behaviour, popped in order. Lets ONE page mid-sweep refuse. */
  interface MoveStep { accept: boolean; enumerate: boolean; move: number | null }
  const st = {
    folders: [] as { path: string; name: string; specialUse?: string; subscribed: boolean }[],
    mailbox: {} as Record<string, Msg[]>,
    uidValidity: 777 as number | null,
    moveScript: [] as MoveStep[],
    defaultStep: { accept: true, enumerate: true, move: null } as MoveStep,
    moves: [] as { source: string; uids: number[]; destination: string }[],
    searches: 0,
    /** nth fetch call (1-indexed) stalls for this many microtask ticks. */
    fetchStall: {} as Record<number, number>,
    fetches: 0,
    reset(): void {
      st.folders = []; st.mailbox = {}; st.uidValidity = 777;
      st.moveScript = []; st.defaultStep = { accept: true, enumerate: true, move: null };
      st.moves = []; st.searches = 0; st.fetchStall = {}; st.fetches = 0;
    },
  };
  class FakeImapFlow {
    mailbox: { exists: number; uidValidity?: bigint } | undefined;
    selected = "";
    constructor(_o: unknown) { /* noop */ }
    private here(): Msg[] { return st.mailbox[this.selected] ??= []; }
    async connect(): Promise<void> { /* noop */ }
    async logout(): Promise<void> { /* noop */ }
    close(): void { /* noop */ }
    async list(): Promise<unknown[]> { return st.folders; }
    async getMailboxLock(path: string): Promise<{ release: () => void }> {
      this.selected = path;
      this.mailbox = st.uidValidity === null
        ? { exists: this.here().length }
        : { exists: this.here().length, uidValidity: BigInt(st.uidValidity) };
      return { release: () => undefined };
    }
    async search(_q: Record<string, unknown>): Promise<number[]> {
      st.searches++;
      return this.here().map((m) => m.uid);
    }
    async *fetch(range: number[] | string, opts: { source?: boolean }): AsyncGenerator<unknown> {
      const n = ++st.fetches;
      for (let i = 0; i < (st.fetchStall[n] ?? 0); i++) await Promise.resolve();
      const here = this.here();
      const chosen = Array.isArray(range) ? here.filter((m) => range.includes(m.uid)) : here;
      for (const m of chosen) {
        yield {
          uid: m.uid,
          envelope: { from: [{ address: m.from }], subject: m.subject, date: m.date, messageId: `<${m.uid}@x>` },
          ...(opts?.source ? { source: Buffer.from(`Subject: ${m.subject}\r\n\r\n${m.body}`) } : {}),
        };
      }
    }
    async messageMove(uids: number[], destination: string): Promise<unknown> {
      st.moves.push({ source: this.selected, uids, destination });
      const step = st.moveScript.shift() ?? st.defaultStep;
      if (!step.accept) return false;
      const here = this.here();
      const present = uids.filter((u) => here.some((m) => m.uid === u));
      const actually = step.move === null ? present : present.slice(0, step.move);
      const leaving = here.filter((m) => actually.includes(m.uid));
      st.mailbox[this.selected] = here.filter((m) => !actually.includes(m.uid));
      (st.mailbox[destination] ??= []).push(...leaving);
      if (!step.enumerate) return {};
      return { uidMap: new Map(actually.map((u, i) => [u, 9000 + i])) };
    }
    async messageFlagsAdd(): Promise<boolean> { return true; }
    async messageFlagsRemove(): Promise<boolean> { return true; }
  }
  return { st, FakeImapFlow };
});

vi.mock("imapflow", () => ({ ImapFlow: h.FakeImapFlow }));
const st = h.st;
const { emailDelete } = await import("./email-mutate-tools.js");
const { _resetSweepsForTest } = await import("./email-delete-sweep.js");

const ENV = ["IMAP_HOST", "IMAP_USER", "IMAP_PASS", "IMAP_PORT"];
let saved: Record<string, string | undefined>;
let dataDir: string;
const FOLDERS = [
  { path: "INBOX", name: "INBOX", subscribed: true },
  { path: "Bin", name: "Bin", specialUse: "\\Trash", subscribed: true },
  { path: "receipts", name: "receipts", subscribed: true },
];
function msgs(n: number, startUid = 1000) {
  return Array.from({ length: n }, (_, i) => ({
    uid: startUid + i, from: "a@b.com", subject: `S${i}`,
    date: new Date("2026-01-01T00:00:00Z"), seen: false, body: "body",
  }));
}
const inFolder = (p: string) => (st.mailbox[p] ?? []).map((m) => m.uid);

beforeEach(() => {
  st.reset();
  _resetSweepsForTest();
  saved = Object.fromEntries([...ENV, "LAX_DATA_DIR"].map((k) => [k, process.env[k]]));
  dataDir = mkdtempSync(join(tmpdir(), "skeptic-"));
  process.env.LAX_DATA_DIR = dataDir;
  process.env.IMAP_HOST = "imap.example.com";
  process.env.IMAP_USER = "me@example.com";
  process.env.IMAP_PASS = "secret";
});
afterEach(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
  rmSync(dataDir, { recursive: true, force: true });
});

async function del(args: Record<string, unknown>) {
  const result = await emailDelete.execute(args);
  return { result, payload: result.isError ? null : JSON.parse(String(result.content)) };
}

/** Open a sweep over `count` msgs in INBOX at page size `limit`. */
async function openCursor(count: number, limit: number): Promise<string> {
  st.folders = FOLDERS;
  st.mailbox = { INBOX: msgs(count) };
  const { result } = await del({ from: "a@b.com", limit });
  expect(result.isError, "expected the truncation guard to fire").toBe(true);
  const m = /cursor="([^"]+)"/.exec(String(result.content));
  expect(m, `no cursor in: ${String(result.content)}`).toBeTruthy();
  return String(m?.[1]);
}

/** Drive to the end. Returns the last SUCCESSFUL payload, or the failure. */
async function runToEnd(start: string, limit: number, maxPages = 12) {
  let cursor = start;
  const texts: string[] = [];
  for (let i = 0; i < maxPages; i++) {
    const page = await del({ cursor, limit });
    texts.push(String(page.result.content));
    if (page.result.isError) return { payload: null as null, failed: true, texts, pages: i + 1 };
    if (!page.payload.cursor) return { payload: page.payload, failed: false, texts, pages: i + 1 };
    cursor = String(page.payload.cursor);
  }
  return { payload: null as null, failed: false, texts, pages: maxPages, spun: true };
}

/** The terminal completion claim, in any of the three ways it is phrased. */
function claimsDone(note: string): boolean {
  return /FINISHED/.test(note) || /has been dealt with/.test(note) || /Do not call the cursor again/.test(note);
}

describe("SKEPTIC: a sweep may not claim completion over mail it did not move", () => {
  it("shape A — confirmed partial move on every page", async () => {
    const cursor = await openCursor(5, 4);
    st.defaultStep = { accept: true, enumerate: true, move: 1 };
    const end = await runToEnd(cursor, 4);
    expect(end.spun).toBeFalsy();
    expect(end.failed).toBe(false);
    const left = inFolder("INBOX");
    expect(left.length, "premise: mail left behind").toBeGreaterThan(0);
    const note = String(end.payload!.note);
    expect(claimsDone(note), `claimed done with ${left.length} left: ${note}`).toBe(false);
    expect(end.payload!.unconfirmed).toBe(left.length);
    expect(note).toMatch(/Re-run email_delete with the original search filters/);
    expect(note).toMatch(/NOT finished/);
  });

  it("shape B — partial with NO UIDPLUS enumeration", async () => {
    const cursor = await openCursor(5, 4);
    st.defaultStep = { accept: true, enumerate: false, move: 2 };
    const end = await runToEnd(cursor, 4);
    const left = inFolder("INBOX");
    expect(left.length).toBeGreaterThan(0);
    const note = String(end.payload!.note);
    expect(claimsDone(note), note).toBe(false);
    expect(end.payload!.unconfirmed, "unconfirmed page counted as moved").toBe(5);
    expect(note).toMatch(/UNKNOWN/);
  });

  it("shape C — the server refuses a page ENTIRELY mid-sweep", async () => {
    const cursor = await openCursor(6, 2);
    // page1 fine, page2 refused outright, page3 fine.
    st.moveScript = [
      { accept: true, enumerate: true, move: null },
      { accept: false, enumerate: true, move: null },
    ];
    const p1 = await del({ cursor, limit: 2 });
    expect(p1.result.isError).toBeFalsy();
    const p2 = await del({ cursor: String(p1.payload.cursor), limit: 2 });
    expect(p2.result.isError, "a wholly refused page must be an error").toBe(true);
    expect(claimsDone(String(p2.result.content))).toBe(false);
    expect(String(p2.result.content)).toMatch(/refused the move/);
    // the cursor must NOT have advanced past the refused page
    const p3 = await del({ cursor: String(p1.payload.cursor), limit: 2 });
    expect(st.moves[st.moves.length - 1].uids, "cursor advanced past a refused page").toEqual([1002, 1003]);
    expect(p3.result.isError).toBeFalsy();
    const p4 = await del({ cursor: String(p3.payload.cursor), limit: 2 });
    expect(p4.result.isError).toBeFalsy();
    expect(inFolder("INBOX")).toEqual([]);
    expect(String(p4.payload.note)).toMatch(/FINISHED/);
  });

  it("shape C2 — a server that NEVER accepts: no false completion, no silent skip", async () => {
    const cursor = await openCursor(6, 2);
    st.defaultStep = { accept: false, enumerate: true, move: null };
    const end = await runToEnd(cursor, 2, 6);
    expect(end.failed, "every page refused should surface as an error, never a finish").toBe(true);
    for (const t of end.texts) expect(claimsDone(t), t).toBe(false);
    expect(inFolder("INBOX")).toHaveLength(6);
  });

  it("shape D — skipped AND refused in the same page", async () => {
    const cursor = await openCursor(6, 3);
    // page 1: uid 1000 already gone (skip), server refuses the remaining two.
    st.mailbox.INBOX = st.mailbox.INBOX.filter((m) => m.uid !== 1000);
    st.moveScript = [{ accept: false, enumerate: true, move: null }];
    const p1 = await del({ cursor, limit: 3 });
    expect(p1.result.isError).toBe(true);
    expect(claimsDone(String(p1.result.content))).toBe(false);
    // now let it through partially and finish
    st.defaultStep = { accept: true, enumerate: true, move: 1 };
    const end = await runToEnd(String(cursor), 3);
    const left = inFolder("INBOX");
    const note = String(end.payload!.note);
    expect(claimsDone(note), `left=${JSON.stringify(left)} note=${note}`).toBe(false);
    expect(end.payload!.unconfirmed).toBe(left.length);
  });

  it("shape E — only the LAST page is partial", async () => {
    const cursor = await openCursor(6, 2);
    st.moveScript = [
      { accept: true, enumerate: true, move: null },
      { accept: true, enumerate: true, move: null },
      { accept: true, enumerate: true, move: 1 },
    ];
    const end = await runToEnd(cursor, 2);
    expect(inFolder("INBOX")).toEqual([1005]);
    const note = String(end.payload!.note);
    expect(claimsDone(note), note).toBe(false);
    expect(end.payload!.unconfirmed).toBe(1);
  });

  it("shape F — only the FIRST page is partial, later pages perfect", async () => {
    const cursor = await openCursor(6, 2);
    st.moveScript = [{ accept: true, enumerate: true, move: 1 }];
    const end = await runToEnd(cursor, 2);
    expect(inFolder("INBOX")).toEqual([1001]);
    const note = String(end.payload!.note);
    expect(claimsDone(note), "residue from an EARLY page was forgotten by the last one").toBe(false);
    expect(end.payload!.unconfirmed).toBe(1);
  });

  it("a fully-confirmed sweep still says FINISHED", async () => {
    const cursor = await openCursor(6, 2);
    const end = await runToEnd(cursor, 2);
    expect(inFolder("INBOX")).toEqual([]);
    expect(end.payload!.unconfirmed).toBe(0);
    expect(String(end.payload!.note)).toMatch(/FINISHED/);
  });
});

describe("SKEPTIC: two in-flight calls on ONE cursor", () => {
  it("the commit===null fallback can still print a completion claim over residue", async () => {
    const cursor = await openCursor(4, 2);
    st.moveScript = [{ accept: true, enumerate: true, move: 1 }]; // page1 leaves 1 behind
    const p1 = await del({ cursor, limit: 2 });
    expect(p1.result.isError).toBeFalsy();
    expect(inFolder("INBOX")).toEqual([1001, 1002, 1003]);
    const c2 = String(p1.payload.cursor);
    // the SAME cursor dispatched twice concurrently (parallel tool calls)
    const [a, b] = await Promise.all([del({ cursor: c2, limit: 2 }), del({ cursor: c2, limit: 2 })]);
    const notes = [a, b].filter((x) => !x.result.isError).map((x) => String(x.payload.note));
    const left = inFolder("INBOX");
    // eslint-disable-next-line no-console
    console.log("LEFT:", JSON.stringify(left), "\nNOTES:", JSON.stringify(notes, null, 1));
    if (left.length > 0) {
      for (const n of notes) expect(claimsDone(n), `claimed done with ${JSON.stringify(left)} left: ${n}`).toBe(false);
    }
  });
});

describe("SKEPTIC: forced ordering into the commit===null fallback", () => {
  it("a slow duplicate call prints the completion claim over an earlier page's residue", async () => {
    const cursor = await openCursor(4, 2);
    st.moveScript = [{ accept: true, enumerate: true, move: 1 }];
    const p1 = await del({ cursor, limit: 2 });
    expect(inFolder("INBOX"), "premise: page 1 left 1001 behind").toEqual([1001, 1002, 1003]);
    const c2 = String(p1.payload.cursor);

    // D is dispatched first but stalls inside its resolve; C overtakes it,
    // finishes the sweep, and DELETES the store entry.
    st.fetchStall = { 2: 40 };
    const dPromise = del({ cursor: c2, limit: 2 });
    for (let i = 0; i < 8; i++) await Promise.resolve();
    const c = await del({ cursor: c2, limit: 2 });
    const d = await dPromise;

    const left = inFolder("INBOX");
    const cNote = c.result.isError ? String(c.result.content) : String(c.payload.note);
    const dNote = d.result.isError ? String(d.result.content) : String(d.payload.note);
    // eslint-disable-next-line no-console
    console.log("LEFT:", JSON.stringify(left), "\nC:", cNote, "\nD:", dNote);
    expect(left).toEqual([1001]);
    expect(claimsDone(cNote), `C claimed done: ${cNote}`).toBe(false);
    expect(claimsDone(dNote), `D claimed done over residue: ${dNote}`).toBe(false);
  });
});

describe("SKEPTIC: accounting sums", () => {
  it("moved + skipped + unconfirmed accounts for total, and moved never over-reports", async () => {
    const cursor = await openCursor(6, 2);
    st.moveScript = [
      { accept: true, enumerate: true, move: 1 },   // 1 moved, 1 unconfirmed
      { accept: true, enumerate: false, move: 2 },  // 2 moved but unenumerated
      { accept: true, enumerate: true, move: null },
    ];
    let cur = cursor;
    let movedSum = 0; let skippedSum = 0;
    let last: Record<string, unknown> | null = null;
    for (let i = 0; i < 5; i++) {
      const p = await del({ cursor: cur, limit: 2 });
      expect(p.result.isError).toBeFalsy();
      movedSum += typeof p.payload.moved === "number" ? p.payload.moved : 0;
      skippedSum += p.payload.skipped ?? 0;
      last = p.payload;
      if (!p.payload.cursor) break;
      cur = String(p.payload.cursor);
    }
    const unconfirmed = Number(last!.unconfirmed);
    // Per-page `moved` is null when unenumerated, so the confirmed sum is 1+2=3.
    expect(movedSum).toBe(3);
    expect(skippedSum).toBe(0);
    expect(movedSum + skippedSum + unconfirmed, "counters do not sum to the resolved set").toBe(6);
    // and `moved` never claims mail still sitting in INBOX
    const stillThere = inFolder("INBOX").length;
    expect(movedSum).toBeLessThanOrEqual(6 - stillThere);
  });

  it("skipped mail counts as dealt with, not as a shortfall", async () => {
    const cursor = await openCursor(5, 4);
    st.mailbox.INBOX = st.mailbox.INBOX.filter((m) => m.uid !== 1002);
    const end = await runToEnd(cursor, 4);
    expect(end.payload!.unconfirmed).toBe(0);
    expect(String(end.payload!.note)).toMatch(/FINISHED/);
  });
});

describe("SKEPTIC: prior invariants", () => {
  it("4 -> 1 SEARCH: a whole sweep costs exactly one search", async () => {
    st.folders = FOLDERS;
    st.mailbox = { INBOX: msgs(650) };
    const first = await del({ from: "a@b.com", limit: 250 });
    let cur = String(/cursor="([^"]+)"/.exec(String(first.result.content))?.[1]);
    for (let i = 0; i < 5; i++) {
      const p = await del({ cursor: cur, limit: 250 });
      expect(p.result.isError).toBeFalsy();
      if (!p.payload.cursor) break;
      cur = String(p.payload.cursor);
    }
    expect(st.searches).toBe(1);
    expect(inFolder("INBOX")).toEqual([]);
  });

  it("a forged cursor is refused without dialling the server", async () => {
    st.folders = FOLDERS;
    st.mailbox = { INBOX: msgs(3) };
    const { result } = await del({ cursor: "edc1.Zm9yZ2Vk" });
    expect(result.isError).toBe(true);
    expect(st.moves).toEqual([]);
  });

  it("a cursor pointed at another folder is refused", async () => {
    const cursor = await openCursor(6, 2);
    const { result } = await del({ cursor, folder: "receipts", limit: 2 });
    expect(result.isError).toBe(true);
    expect(st.moves).toEqual([]);
  });

  it("a renumbered mailbox kills the cursor", async () => {
    const cursor = await openCursor(6, 2);
    st.uidValidity = 999;
    const { result } = await del({ cursor, limit: 2 });
    expect(result.isError).toBe(true);
    expect(String(result.content)).toMatch(/RENUMBERED/);
    expect(st.moves).toEqual([]);
    const retry = await del({ cursor, limit: 2 });
    expect(String(retry.result.content)).toMatch(/no longer usable/);
  });

  it("caller-supplied uids from the wrong folder are refused, not skipped", async () => {
    st.folders = FOLDERS;
    st.mailbox = { INBOX: msgs(2), receipts: msgs(2, 5000) };
    const { result } = await del({ folder: "INBOX", uids: [5000, 5001] });
    expect(result.isError).toBe(true);
    expect(st.moves).toEqual([]);
  });

  it("no UIDVALIDITY: single-shot still deletes, no cursor is minted, continuation refused", async () => {
    st.folders = FOLDERS;
    st.mailbox = { INBOX: msgs(3) };
    st.uidValidity = null;
    const one = await del({ from: "a@b.com" });
    expect(one.result.isError, String(one.result.content)).toBeFalsy();
    expect(one.payload.moved).toBe(3);

    st.mailbox = { INBOX: msgs(650) };
    const trunc = await del({ from: "a@b.com", limit: 250 });
    expect(trunc.result.isError).toBe(true);
    expect(String(trunc.result.content)).not.toMatch(/cursor="/);

    // continuation guard: epoch at SEARCH, gone by the next call
    st.uidValidity = 777;
    st.mailbox = { INBOX: msgs(6) };
    _resetSweepsForTest();
    const cursor = await openCursor(6, 2);
    st.uidValidity = null;
    const cont = await del({ cursor, limit: 2 });
    expect(cont.result.isError).toBe(true);
    expect(String(cont.result.content)).toMatch(/not reporting a UIDVALIDITY/);
    expect(inFolder("INBOX")).toHaveLength(6);
  });
});
