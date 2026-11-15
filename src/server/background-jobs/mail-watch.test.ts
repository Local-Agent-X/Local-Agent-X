// The mail watcher end to end over a fake mailbox and a fake model: what it
// reads, what it raises in the inbox, what waits for the digest, and what a
// failure tells the user.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getRuntimeConfig, setRuntimeConfig } from "../../config.js";
import type { AgentTurn, LAXConfig } from "../../types.js";
import type { ImapSession, SearchObject } from "../../tools/email-imap.js";
import { listInbox } from "../../inbox/index.js";
import { EventBus } from "../../event-bus.js";
import { LocalModelUnavailableError, type ReviewForkRequest } from "./review-fork.js";
import { DAILY_CALL_CAP, FAILURES_BEFORE_NOTICE, postDigestIfDue, registerMailWatchRunner, runMailWatchPass, type MailWatchDeps } from "./mail-watch.js";
import { loadMailWatchState, saveMailWatchState, emptyState } from "./mail-watch-state.js";
import { MAX_PER_PASS, addressOf } from "./mail-watch-mail.js";
import { parseMailVerdicts } from "./mail-watch-prompt.js";

const ORIGINAL_CFG = getRuntimeConfig();
const ORIGINAL_DIR = process.env.LAX_DATA_DIR;
let dir: string;

interface Msg { uid: number; from: string; subject: string; snippet?: string; to?: string }

/** A mailbox the watcher can only search, fetch and list, like the real one. */
function fakeMailbox(inbox: Msg[], sent: Msg[] = [], uidValidity = "1") {
  const calls: string[] = [];
  const box = { inbox, sent, uidValidity };
  const session: ImapSession = {
    listFolders: async () => [{ path: "Sent", name: "Sent", specialUse: "\\Sent", subscribed: true }],
    searchUids: async (folder: string, q: SearchObject) => {
      calls.push(`search ${folder} ${JSON.stringify(q)}`);
      const list = folder === "Sent" ? box.sent : box.inbox;
      const query = q as { uid?: string; to?: string; since?: Date };
      let uids = list.map((m) => m.uid);
      if (query.to) uids = list.filter((m) => m.to === query.to).map((m) => m.uid);
      if (query.uid === "*") uids = uids.length ? [Math.max(...uids)] : [];
      else if (query.uid) {
        const from = Number(query.uid.split(":")[0]);
        const max = Math.max(0, ...uids);
        uids = uids.filter((u) => u >= from);
        if (uids.length === 0 && max > 0) uids = [max];
      }
      return { uids, uidValidity: box.uidValidity };
    },
    fetchMessages: async (_folder: string, uids: number[] | null) => {
      const messages = box.inbox.filter((m) => uids?.includes(m.uid)).map((m) => ({
        uid: m.uid, from: m.from, subject: m.subject, date: "2026-11-14T10:00:00.000Z", messageId: `<${m.uid}@x>`, snippet: m.snippet ?? "",
      }));
      return { messages, total: messages.length, returned: messages.length, truncated: false };
    },
    fetchHeaders: async () => [], search: async () => ({ messages: [], total: 0, returned: 0, truncated: false }),
    resolveUids: async () => ({ headers: [], uidValidity: box.uidValidity }), fetchBody: async () => { throw new Error("not read"); },
    moveMessages: async () => { throw new Error("the watcher must never move mail"); },
    setFlags: async () => { throw new Error("the watcher must never flag mail"); },
  };
  return { box, session, calls };
}

const reply = (text: string): AgentTurn => ({ messages: [{ role: "assistant", content: text }], stopReason: "end_turn" } as unknown as AgentTurn);

function setup(inbox: Msg[], opts: { sent?: Msg[]; verdicts?: (uids: number[]) => string; now?: Date } = {}) {
  const mailbox = fakeMailbox(inbox, opts.sent);
  const forks: ReviewForkRequest[] = [];
  const runFork = vi.fn(async (req: ReviewForkRequest) => {
    forks.push(req);
    const uids = [...req.message.matchAll(/uid: (\d+)/g)].map((m) => Number(m[1]));
    return reply(opts.verdicts ? opts.verdicts(uids) : JSON.stringify({ messages: uids.map((uid) => ({ uid, important: false, category: "other", why: "" })) }));
  });
  let now = opts.now ?? new Date(2026, 10, 14, 10, 0);
  const d: MailWatchDeps = {
    config: getRuntimeConfig(), dataDir: dir, secretsStore: {} as never, security: {} as never, toolPolicy: {} as never,
    now: () => now,
    accounts: () => [{ id: "me@example.com", creds: { host: "h", port: 993, user: "me@example.com", pass: "p" } }],
    session: (async (_c, fn) => fn(mailbox.session)) as MailWatchDeps["session"],
    calendar: async () => ({ events: [{ id: "e", title: "Dinner with Greg", start: "2026-11-14T17:00:00", end: "2026-11-14T18:00:00", sourceId: "lax" }], unreadable: [] }),
    runFork: runFork as unknown as MailWatchDeps["runFork"],
  };
  registerMailWatchRunner(d);
  return { mailbox, forks, runFork, d, setNow: (n: Date) => { now = n; } };
}

const important = (uid: number, category: string, why: string) => ({ uid, important: true, category, why });
const titles = () => listInbox().items.map((i) => i.title);

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "lax-mail-watch-"));
  process.env.LAX_DATA_DIR = dir;
  setRuntimeConfig({ ...ORIGINAL_CFG, mailWatchEnabled: true, mailWatchLocalOnly: false, localOnlyMode: false, quietHoursEnd: "07:00" } as LAXConfig);
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));
afterAll(() => {
  setRuntimeConfig(ORIGINAL_CFG);
  if (ORIGINAL_DIR === undefined) delete process.env.LAX_DATA_DIR;
  else process.env.LAX_DATA_DIR = ORIGINAL_DIR;
});

describe("mail watch", () => {
  it("raises the important mail, rings travel through quiet hours, and keeps the rest for the digest", async () => {
    const posted: Array<{ title: string; ring?: boolean }> = [];
    const listen = ({ item, ringThroughQuietHours }: { item: { title: string }; ringThroughQuietHours?: boolean }) => { posted.push({ title: item.title, ring: ringThroughQuietHours }); };
    EventBus.on("inbox:posted", listen);
    const { forks } = setup([
      { uid: 5, from: "Acme Hiring <jobs@acme.com>", subject: "Interview on Tuesday" },
      { uid: 6, from: "Airline <noreply@air.com>", subject: "Flight AA12 delayed" },
      { uid: 7, from: "Shop <deals@shop.com>", subject: "50% off" },
    ], { verdicts: () => JSON.stringify({ messages: [important(5, "job", "Interview invite from Acme"), important(6, "travel", "Your flight is delayed 2h"), { uid: 7, important: false, category: "other", why: "" }] }) });
    await runMailWatchPass();
    EventBus.off("inbox:posted", listen);
    expect(titles()).toEqual(expect.arrayContaining(["Acme Hiring: Interview on Tuesday", "Airline: Flight AA12 delayed"]));
    expect(titles()).toHaveLength(2);
    expect(posted.find((p) => p.title.startsWith("Airline"))?.ring).toBe(true);
    expect(posted.find((p) => p.title.startsWith("Acme"))?.ring).toBeUndefined();
    expect(loadMailWatchState().digest.pending.map((p) => p.subject)).toEqual(["50% off"]);
    // Read-only, no tools, mail fenced as external content, calendar in view.
    expect(forks[0]?.tools).toEqual([]);
    expect(forks[0]?.message).toContain("Dinner with Greg");
    expect(forks[0]?.message).toMatch(/EXTERNAL/);
  });

  it("reads only what is new: the first pass looks back a day, later passes start after the last uid", async () => {
    const { mailbox, runFork } = setup([{ uid: 10, from: "a <a@x.com>", subject: "one" }]);
    await runMailWatchPass();
    expect(mailbox.calls[0]).toContain("since");
    expect(loadMailWatchState().accounts["me@example.com"]).toEqual({ uidValidity: "1", lastUid: 10 });
    await runMailWatchPass();
    expect(runFork).toHaveBeenCalledTimes(1); // nothing new: no model call
    mailbox.box.inbox.push({ uid: 11, from: "b <b@x.com>", subject: "two" });
    await runMailWatchPass();
    expect(runFork).toHaveBeenCalledTimes(2);
    expect(loadMailWatchState().accounts["me@example.com"]?.lastUid).toBe(11);
  });

  it("a first pass with no recent mail marks the newest message, so the next one does not read the whole mailbox", async () => {
    const { mailbox, runFork } = setup([{ uid: 900, from: "old <o@x.com>", subject: "old" }]);
    mailbox.session.searchUids = (async (folder: string, q: SearchObject) => {
      mailbox.calls.push(JSON.stringify(q));
      if ((q as { since?: Date }).since) return { uids: [], uidValidity: "1" };
      return fakeMailbox(mailbox.box.inbox).session.searchUids(folder, q);
    }) as ImapSession["searchUids"];
    await runMailWatchPass();
    expect(runFork).not.toHaveBeenCalled();
    expect(loadMailWatchState().accounts["me@example.com"]?.lastUid).toBe(900);
  });

  it("starts over when the server renumbers the mailbox (UIDVALIDITY changed)", async () => {
    const { mailbox } = setup([{ uid: 3, from: "a <a@x.com>", subject: "one" }]);
    saveMailWatchState({ ...emptyState(), accounts: { "me@example.com": { uidValidity: "0", lastUid: 99 } } });
    await runMailWatchPass();
    expect(mailbox.calls.some((c) => c.includes("since"))).toBe(true);
    expect(loadMailWatchState().accounts["me@example.com"]).toEqual({ uidValidity: "1", lastUid: 3 });
  });

  it("tells the model who the user has written to, from their Sent folder, and never counts their own address", async () => {
    const { forks } = setup(
      [{ uid: 1, from: "Vic <vic@x.com>", subject: "5:00?" }, { uid: 2, from: "Stranger <s@x.com>", subject: "hi" }],
      { sent: [{ uid: 1, from: "me", subject: "re", to: "vic@x.com" }] },
    );
    await runMailWatchPass();
    const msg = forks[0]!.message;
    expect(msg).toMatch(/from: Vic <vic@x\.com>\nknows sender: yes/);
    expect(msg).toMatch(/from: Stranger <s@x\.com>\nknows sender: no/);
    expect(loadMailWatchState().known["vic@x.com"]?.known).toBe(true);
  });

  it("caps a pass at MAX_PER_PASS messages and counts the rest for the digest", async () => {
    const many = Array.from({ length: MAX_PER_PASS + 5 }, (_, i) => ({ uid: i + 1, from: "n <n@x.com>", subject: `m${i}` }));
    const { forks } = setup(many);
    await runMailWatchPass();
    expect([...forks[0]!.message.matchAll(/uid: /g)]).toHaveLength(MAX_PER_PASS);
    const state = loadMailWatchState();
    expect(state.digest.skipped).toBe(5);
    expect(state.accounts["me@example.com"]?.lastUid).toBe(MAX_PER_PASS + 5);
  });

  it("a failed model call keeps the mail for the next pass, and the user is told after repeated failures", async () => {
    const { runFork } = setup([{ uid: 1, from: "a <a@x.com>", subject: "s" }]);
    runFork.mockImplementation(async () => reply("not json"));
    for (let i = 0; i < FAILURES_BEFORE_NOTICE - 1; i++) await runMailWatchPass();
    expect(titles()).toEqual([]);
    expect(loadMailWatchState().accounts["me@example.com"]).toBeUndefined();
    await runMailWatchPass();
    await runMailWatchPass();
    expect(titles()).toEqual(["Your mail isn't being checked right now"]);
  });

  it("local-only: uses only a local model, says so at once when there is none, and waits while a chat turn runs", async () => {
    setRuntimeConfig({ ...getRuntimeConfig(), mailWatchLocalOnly: true } as LAXConfig);
    const { runFork, d } = setup([{ uid: 1, from: "a <a@x.com>", subject: "s" }]);
    registerMailWatchRunner({ ...d, foregroundBusy: () => true });
    expect((await runMailWatchPass()).skipped).toBe("busy");
    registerMailWatchRunner({ ...d, foregroundBusy: () => false });
    runFork.mockImplementation(async (req: ReviewForkRequest) => {
      expect(req.localOnly).toEqual({});
      throw new LocalModelUnavailableError("resolved to \"anthropic\"");
    });
    await runMailWatchPass();
    expect(listInbox().items[0]?.body).toContain("model on this computer only");
  });

  it("does nothing when switched off or with no mail account", async () => {
    const { runFork, d } = setup([{ uid: 1, from: "a <a@x.com>", subject: "s" }]);
    setRuntimeConfig({ ...getRuntimeConfig(), mailWatchEnabled: false } as LAXConfig);
    expect((await runMailWatchPass()).skipped).toBe("disabled");
    setRuntimeConfig({ ...getRuntimeConfig(), mailWatchEnabled: true } as LAXConfig);
    registerMailWatchRunner({ ...d, accounts: () => [] });
    expect((await runMailWatchPass()).skipped).toBe("no-account");
    expect(runFork).not.toHaveBeenCalled();
  });

  it("past the daily cap, new mail goes to the digest unjudged", async () => {
    const { runFork } = setup([{ uid: 1, from: "a <a@x.com>", subject: "late" }]);
    saveMailWatchState({ ...emptyState(), usage: { day: "2026-11-14", calls: DAILY_CALL_CAP } });
    await runMailWatchPass();
    expect(runFork).not.toHaveBeenCalled();
    expect(loadMailWatchState().digest.pending.map((p) => p.subject)).toEqual(["late"]);
  });
});

describe("digest", () => {
  it("posts once, at the end of quiet hours, and empties the queue", () => {
    const state = { ...emptyState(), digest: { pending: [{ from: "Shop <d@s.com>", subject: "Sale", date: "" }], skipped: 2 } };
    postDigestIfDue(state, new Date(2026, 10, 14, 6, 59), "07:00");
    expect(titles()).toEqual([]);
    postDigestIfDue(state, new Date(2026, 10, 14, 7, 0), "07:00");
    expect(titles()).toEqual(["Mail digest: 3 messages that didn't need you right away"]);
    expect(listInbox().items[0]?.body).toContain("Shop: Sale");
    expect(state.digest).toEqual({ pending: [], skipped: 0, lastPostedDay: "2026-11-14" });
    state.digest.pending.push({ from: "x", subject: "y", date: "" });
    postDigestIfDue(state, new Date(2026, 10, 14, 9, 0), "07:00");
    expect(titles()).toHaveLength(1);
  });
});

describe("verdicts", () => {
  it("keeps only asked-about uids, once each; 'other' is never important; junk is null", () => {
    const v = parseMailVerdicts('Sure! {"messages":[{"uid":1,"important":true,"category":"job","why":"Offer"},{"uid":1,"important":false},{"uid":9,"important":true,"category":"job"},{"uid":2,"important":true,"category":"other"}]}', [1, 2]);
    expect(v).toEqual([{ uid: 1, important: true, category: "job", why: "Offer" }, { uid: 2, important: false, category: "other", why: "" }]);
    expect(parseMailVerdicts("no", [1])).toBeNull();
    expect(parseMailVerdicts('{"verdict":1}', [1])).toBeNull();
  });

  it("reads the address out of a From line", () => {
    expect(addressOf("Vic Smith <Vic@X.com>")).toBe("vic@x.com");
    expect(addressOf("vic@x.com")).toBe("vic@x.com");
    expect(addressOf("unknown")).toBe("");
  });
});
