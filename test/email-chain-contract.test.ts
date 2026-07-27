/**
 * CROSS-SEAM CONTRACT for the email subsystem — chunk C7, the integration gate.
 *
 * Six chunks rebuilt this subsystem and each was verified alone. Per-chunk green
 * is necessary and not sufficient: the defects this campaign actually shipped
 * lived at the joins, and four of the six chunks were blocked and repaired. This
 * file drives the chain through PRODUCTION entrypoints — tools are looked up in
 * the registry the model is served from and invoked through their own
 * `execute()`, so the argument layer (email-tool-args.ts), the config gate
 * (email-config.ts), the query compiler (email-search-query.ts), the folder
 * resolver (email-mutate-shared.ts) and the IMAP layer (email-imap.ts) all run
 * for real. The only substitution is `imapflow` itself — replaced by a fake
 * SERVER, not by a fake of anything this campaign wrote.
 *
 * ── WHAT A GREEN RUN HERE DOES AND DOES NOT MEAN ────────────────────────────
 *
 * It is not "the email subsystem is correct". A gate that claims more than it
 * drives is how the PREVIOUS campaign shipped a broken one, so the links are
 * enumerated, and every link this file does NOT drive names the suite that owns
 * it. If you are about to trust a green run, read this list first.
 *
 * DRIVEN HERE, end to end:
 *   builtin declaration → the real IntegrationRegistry → getAgentContext()
 *     → the unified tool registry (buildToolRegistry) → the availability gate
 *     → the deferred manifest, read back out of a real assembled system prompt
 *     → email_search / email_read / email_read_message → email_folders
 *     → email_delete / email_mark → the IMAP data layer
 *   ...specifically: barrel registration and single-registration; the three
 *   availability states on both the schema and manifest surfaces; the config
 *   gate at execute(); the search date window and sender predicate as COMPILED
 *   and as sent; the whole-mailbox refusal standing between a selector-less
 *   `email_delete` and the mailbox; the argument layer's refusal of a
 *   non-string date; `email_read`'s page size against a real mailbox;
 *   folder-role resolution (\Trash by role, not by name); the explicit-folder
 *   guard for every uid-taking mutating verb in the barrel; and the move
 *   itself, checked against per-folder server state.
 *
 * NOT DRIVEN HERE — owned by, and only by:
 *   · egress / secret-exfil extraction for email_send (which arg fields are
 *     scanned before bytes leave the box) — src/tool-execution/egress-gates.ts,
 *     gated by src/tool-execution/capability-class-gates.test.ts, which fails
 *     if `bcc` or `html` stops being extracted. DECIDED, not an oversight: that
 *     gate is a property of the tool-execution pipeline over ALL egress tools,
 *     not of this mail chain, and restating it here would fork the definition
 *     of "which fields egress" into two places — the exact failure mode this
 *     campaign spent four chunks on.
 *   · the full date-parsing grammar (relative units, calendar clamping, the
 *     1970 floor) — parseDateInput's cases in src/tools/email-read-tools.test.ts.
 *     This file drives ONE case: that a refusal from that layer reaches the
 *     composed path as a refusal instead of a silently dropped predicate.
 *   · body decoding, MIME part selection, attachment metadata, truncation —
 *     src/tools/email-read-tools.test.ts, plus email-body-render's cases in
 *     src/tools/email-imap.test.ts.
 *   · SMTP composition and sending — src/tools/email-send-tool.test.ts.
 *     email_send appears here only as an AVAILABILITY subject; no mail is sent.
 *   · connection handling, UIDPLUS confirmation, the no-permanent-removal
 *     source assertion (E1) — src/tools/email-imap.test.ts.
 *   · folder listing beyond \Trash resolution — src/tools/email-folder-tools.test.ts.
 *   · install/credential ownership and the upgrade path —
 *     test/integration-seam-contract.test.ts (see below).
 *
 * KNOWN GAP, stated rather than papered over: the agent-context half of the
 * chain (getAgentContext) is exercised only as far as buildSystemPrompt()
 * consumes it; there is no assertion here about how the integration's own
 * context block renders.
 *
 * RELATIONSHIP TO test/integration-seam-contract.test.ts: that file is the
 * previous campaign's gate and owns the INSTALL half — which credential lands in
 * which sink, ownership, the upgrade path. This one owns the half that had no
 * coverage at all: that the tools, resolved from the real registry, compose into
 * the journey the campaign exists for. The three availability states are
 * observed here too, because they are what GATES the execution below; they are
 * asserted through the registry lookup rather than through the install route.
 *
 * WHICH SEAM BROKE — every assertion carries a message naming the link.
 *
 * NON-VACUITY: the manifest assertions in the unconfigured and send-only states
 * are NEGATIVE, and an unemitted manifest satisfies every negative assertion.
 * The positive half is pinned first, in `describe("the deferred manifest is
 * emitted at all")`, and each subject in this file was switched off and observed
 * to go red — see the chunk report.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { ToolDefinition, ToolResult } from "../src/types.js";

// ── the fake IMAP SERVER ────────────────────────────────────────────────────
//
// Modelled on the one in src/tools/email-mutate-tools.test.ts, and it keeps the
// three properties that file learned the hard way: messages are keyed BY FOLDER
// (IMAP uids are per-mailbox, and a single global list cannot express the
// wrong-target bug at all), SEARCH HONOURS ITS QUERY (so a dropped predicate is
// detectable), and every uid-taking verb is scoped to the SELECTed mailbox.

interface FakeFolder { path: string; name: string; specialUse?: string; subscribed: boolean }

const h = vi.hoisted(() => {
  interface Msg {
    uid: number; from: string; subject: string; date: Date; seen: boolean; body: string;
  }
  type Query = Record<string, unknown>;

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
    folders: [] as { path: string; name: string; specialUse?: string; subscribed: boolean }[],
    mailbox: {} as Record<string, Msg[]>,
    calls: [] as string[],
    searchQueries: [] as Query[],
    moves: [] as { source: string; uids: number[]; destination: string }[],
    flagOps: [] as { folder: string; uids: number[]; flags: string[]; action: string }[],
    reset(): void {
      state.folders = [];
      state.mailbox = {};
      state.calls = [];
      state.searchQueries = [];
      state.moves = [];
      state.flagOps = [];
    },
  };

  /** Every message has ONE text/plain part, addressed as BODY[1]. */
  const STRUCTURE = { type: "text/plain", part: "1", size: 64 };

  class FakeImapFlow {
    mailbox: { exists: number } | undefined;
    selected = "";
    constructor(_opts: unknown) { state.calls.push("construct"); }
    private here(): Msg[] { return state.mailbox[this.selected] ??= []; }
    async connect(): Promise<void> { state.calls.push("connect"); }
    async logout(): Promise<void> { state.calls.push("logout"); }
    close(): void { state.calls.push("close"); }
    async list(): Promise<unknown[]> { state.calls.push("list"); return state.folders; }
    async getMailboxLock(path: string): Promise<{ release: () => void }> {
      state.calls.push(`lock:${path}`);
      if (!state.folders.some((f) => f.path === path)) throw new Error(`Mailbox ${path} does not exist`);
      this.selected = path;
      this.mailbox = { exists: this.here().length };
      return { release: () => state.calls.push("release") };
    }
    async search(query: Query): Promise<number[]> {
      state.calls.push("search");
      state.searchQueries.push(query);
      return this.here().filter((m) => matches(m, query)).map((m) => m.uid);
    }
    private shape(m: Msg, opts: { source?: boolean; bodyStructure?: boolean }): unknown {
      return {
        uid: m.uid,
        envelope: { from: [{ address: m.from }], subject: m.subject, date: m.date, messageId: `<${m.uid}@x>` },
        ...(opts?.source ? { source: Buffer.from(`Subject: ${m.subject}\r\n\r\n${m.body}`) } : {}),
        ...(opts?.bodyStructure ? { bodyStructure: STRUCTURE } : {}),
      };
    }
    async *fetch(range: number[] | string, opts: { source?: boolean }): AsyncGenerator<unknown> {
      state.calls.push("fetch");
      const here = this.here();
      let chosen: Msg[];
      if (Array.isArray(range)) {
        chosen = here.filter((m) => range.includes(m.uid));
      } else {
        const [lo, hi] = String(range).split(":");
        const end = hi === "*" ? here.length : Number(hi);
        chosen = here.slice(Math.max(0, Number(lo) - 1), end);
      }
      for (const m of chosen) yield this.shape(m, opts);
    }
    async fetchAll(range: unknown, opts: { bodyStructure?: boolean }): Promise<unknown[]> {
      state.calls.push("fetchAll");
      const uid = Number(String(range));
      return this.here().filter((m) => m.uid === uid).map((m) => this.shape(m, opts));
    }
    async download(range: string, part: string): Promise<unknown> {
      state.calls.push(`download:${part}`);
      const { Readable } = await import("node:stream");
      const msg = this.here().find((m) => m.uid === Number(range));
      if (!msg || part !== "1") throw new Error(`no part ${part}`);
      return { meta: {}, content: Readable.from([Buffer.from(msg.body, "utf-8")]) };
    }
    async messageMove(uids: number[], destination: string): Promise<unknown> {
      state.calls.push("move");
      state.moves.push({ source: this.selected, uids, destination });
      const here = this.here();
      const present = uids.filter((u) => here.some((m) => m.uid === u));
      const leaving = here.filter((m) => present.includes(m.uid));
      state.mailbox[this.selected] = here.filter((m) => !present.includes(m.uid));
      (state.mailbox[destination] ??= []).push(...leaving);
      return { uidMap: new Map(present.map((u, i) => [u, 9000 + i])) };
    }
    private applyFlags(uids: number[], flags: string[], action: "add" | "remove"): boolean {
      state.calls.push(`flags:${action}`);
      state.flagOps.push({ folder: this.selected, uids, flags, action });
      if (flags.includes("\\Seen")) {
        for (const m of this.here()) if (uids.includes(m.uid)) m.seen = action === "add";
      }
      return true;
    }
    async messageFlagsAdd(uids: number[], flags: string[]): Promise<boolean> { return this.applyFlags(uids, flags, "add"); }
    async messageFlagsRemove(uids: number[], flags: string[]): Promise<boolean> { return this.applyFlags(uids, flags, "remove"); }
  }

  return { state, FakeImapFlow };
});

vi.mock("imapflow", () => ({ ImapFlow: h.FakeImapFlow }));

const state = h.state;

const { allTools, buildToolRegistry } = await import("../src/tools/registry-build.js");
const { filterAvailableTools } = await import("../src/tools/tool-search.js");
const { filterToolsForMessage } = await import("../src/agent-request/tool-filter.js");
const { buildSystemPrompt } = await import("../src/agent-request/prepare-request/build-system-prompt.js");
const { IntegrationRegistry } = await import("../src/integrations/index.js");

// ── production entrypoints ──────────────────────────────────────────────────

/** The seven email tools that a mailbox configuration gates. email_setup and
 *  email_draft are deliberately ungated and are not in this list. */
const IMAP_TOOLS = ["email_read", "email_search", "email_read_message", "email_folders", "email_delete", "email_mark"] as const;
const ALL_SEVEN = ["email_send", ...IMAP_TOOLS] as const;

/** The tool as the model gets it: out of the unified registry, not out of an
 *  import of the module under test. A tool that never reached the registry is
 *  dead code however complete it is. */
function fromRegistry(name: string): ToolDefinition {
  const { registry } = buildToolRegistry();
  const tool = registry.get(name);
  expect(tool, `REGISTRY seam: ${name} is not in the unified registry — it never reached allTools, so the model cannot call it`).toBeTruthy();
  return tool!;
}

/** Invoke through the REAL execute(), with a raw argument object shaped the way
 *  a model emits one. Everything below this line is production code. */
async function call(name: string, args: Record<string, unknown> = {}): Promise<ToolResult> {
  return fromRegistry(name).execute(args);
}

function payloadOf(result: ToolResult): Record<string, unknown> {
  expect(result.isError, `TOOL seam: expected a successful result, got: ${String(result.content)}`).toBeFalsy();
  return JSON.parse(String(result.content)) as Record<string, unknown>;
}

const IMAP_ENV = ["IMAP_HOST", "IMAP_USER", "IMAP_PASS", "IMAP_PORT"];
const SMTP_ENV = ["SMTP_HOST", "SMTP_USER", "SMTP_PASS", "SMTP_FROM", "SMTP_PORT"];

let dataDir: string;
let savedEnv: Record<string, string | undefined>;

beforeEach(() => {
  state.reset();
  savedEnv = Object.fromEntries([...IMAP_ENV, ...SMTP_ENV, "LAX_DATA_DIR"].map((k) => [k, process.env[k]]));
  for (const k of [...IMAP_ENV, ...SMTP_ENV]) delete process.env[k];
  // An empty data dir, so the dev box's real ~/.lax/email.json cannot leak in
  // and make the "unconfigured" state pass or fail for the wrong reason.
  dataDir = mkdtempSync(join(tmpdir(), "email-chain-"));
  process.env.LAX_DATA_DIR = dataDir;
});

afterEach(() => {
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  rmSync(dataDir, { recursive: true, force: true });
});

function configureSmtp(): void {
  process.env.SMTP_HOST = "smtp.example.test";
  process.env.SMTP_USER = "me@example.test";
  process.env.SMTP_PASS = "smtp-app-password";
  process.env.SMTP_FROM = "me@example.test";
}
function configureImap(): void {
  process.env.IMAP_HOST = "imap.example.test";
  process.env.IMAP_USER = "me@example.test";
  process.env.IMAP_PASS = "imap-app-password";
}

/**
 * One observation of the availability + manifest surfaces, both read out of the
 * SAME assembled system prompt — which is where they would drift apart.
 *
 * `loaded` is the real main-chat resolver's output. `manifested` is read back
 * out of the prompt rather than recomputed, so a manifest that was never emitted
 * shows up as an empty set rather than as agreement.
 */
async function observe(message = "send an email to bob and check my inbox") {
  const loaded = filterToolsForMessage(allTools, message);
  const prompt = await buildSystemPrompt({
    message,
    sessionId: `chain-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    config: { systemPrompt: "Base prompt." } as never,
    memoryIndex: {} as never,
    integrations: new IntegrationRegistry(dataDir, { has: () => false } as never),
    allAgentTools: allTools,
    loadedTools: loaded,
    resolvedProvider: "anthropic",
    resolvedModel: "claude-opus-4-8",
    contextBlock: "", relevantMemories: "", smartContext: "", memoryContext: "",
    memoryNotifications: [], memoryCurateBlock: "", forceBuildIntent: false,
  });
  const loadedNames = new Set(loaded.map((t) => t.name));
  const manifested = new Set(allTools.filter((t) => prompt.includes(`- ${t.name}:`)).map((t) => t.name));
  return {
    prompt, loadedNames, manifested,
    /** Everywhere the model could learn this tool exists. */
    visible: (name: string) => loadedNames.has(name) || manifested.has(name),
  };
}

/**
 * The tools the main-chat path would actually hand this turn.
 *
 * `filterToolsForMessage` is the production entrypoint, NOT
 * `resolveToolsForRequest` called bare: the email tools are deliberately
 * DEFERRED (no audience tag), and it is tool-filter.ts's keyword router —
 * injected by that wrapper and by nothing else — that surfaces the whole
 * `email_` prefix on a message about mail. Calling the resolver directly returns
 * the eager set only, which would make every "email tool is hidden" assertion
 * below pass for a reason that has nothing to do with the availability gate.
 */
function resolvedNames(message: string): Set<string> {
  return new Set(filterToolsForMessage(allTools, message).map((t) => t.name));
}

// ── the mailbox ─────────────────────────────────────────────────────────────

/** A provider whose Trash is called "Bin" under a vendor prefix, deliberately,
 *  so nothing here can resolve the destination by matching the string "Trash". */
const GMAIL: FakeFolder[] = [
  { path: "INBOX", name: "INBOX", subscribed: true },
  { path: "[Gmail]/All Mail", name: "All Mail", specialUse: "\\All", subscribed: true },
  { path: "[Gmail]/Bin", name: "Bin", specialUse: "\\Trash", subscribed: true },
  { path: "[Gmail]/Sent Mail", name: "Sent Mail", specialUse: "\\Sent", subscribed: true },
  { path: "receipts", name: "receipts", subscribed: true },
];

const OLD = new Date("2024-03-04T09:00:00Z");
const RECENT = new Date(Date.now() - 3 * 86_400_000);

interface Msg { uid: number; from: string; subject: string; date: Date; seen: boolean; body: string }
const msg = (uid: number, from: string, subject: string, date: Date, body: string): Msg =>
  ({ uid, from, subject, date, seen: false, body });

/**
 * The mailbox the campaign's stated purpose runs against: a year of newsletters
 * from one sender, a RECENT one from the same sender that the date window must
 * exclude, mail from someone else that the sender filter must exclude, and a
 * DIFFERENT folder numbering its messages from the same uid — which is the
 * normal case, not a contrivance, because IMAP assigns uids per mailbox.
 */
function loadMailbox(): void {
  state.folders = GMAIL;
  state.mailbox = {
    INBOX: [
      msg(1000, "noreply@vendor.test", "Newsletter #1", OLD, "Unsubscribe at the bottom of this newsletter."),
      msg(1001, "noreply@vendor.test", "Newsletter #2", OLD, "Another newsletter body."),
      msg(1002, "noreply@vendor.test", "Newsletter #3", RECENT, "This one arrived this week."),
      msg(1003, "alice@friend.test", "Lunch?", OLD, "Are you free on Thursday?"),
    ],
    receipts: [
      msg(1000, "shop@store.test", "Receipt A", OLD, "Thanks for your order."),
      msg(1001, "shop@store.test", "Receipt B", OLD, "Thanks again."),
    ],
    "[Gmail]/All Mail": [msg(4000, "noreply@vendor.test", "Archived", OLD, "archived copy")],
    "[Gmail]/Bin": [],
  };
}

const inFolder = (path: string): number[] => (state.mailbox[path] ?? []).map((m) => m.uid);

// ── STATE 0: the deferred manifest is emitted at all ────────────────────────

/**
 * THE POSITIVE HALF. Every manifest assertion in the two gated states below is
 * negative, and an unemitted manifest satisfies all of them. buildSystemPrompt()
 * assembles the manifest inside a `try { } catch { }` marked best-effort, so a
 * future throw there degrades discoverability SILENTLY — there is no downstream
 * assertion that can tell "correctly omitted" from "never emitted".
 */
describe("email chain — the deferred manifest is emitted at all", () => {
  it("emits a manifest and names every available tool this turn's schema left out", async () => {
    configureSmtp();
    configureImap();
    const seen = await observe();

    expect(
      seen.manifested.size,
      "MANIFEST seam: NO deferred manifest was emitted — every negative manifest assertion in this file is passing vacuously",
    ).toBeGreaterThan(0);

    const deferred = filterAvailableTools(allTools).map((t) => t.name).filter((n) => !seen.loadedNames.has(n));
    expect(
      deferred.length,
      "the fixture went degenerate: nothing was deferred this turn, so there is no manifest property left to prove",
    ).toBeGreaterThan(10);
    for (const name of deferred) {
      expect(
        seen.manifested.has(name),
        `MANIFEST seam: ${name} passes the availability gate and did not reach this turn's schema, so unless the manifest names it the model cannot learn it exists`,
      ).toBe(true);
    }
  });

  it("puts the email tools somewhere the model can find them once the mailbox works", async () => {
    configureSmtp();
    configureImap();
    const seen = await observe();
    for (const name of ALL_SEVEN) {
      expect(
        seen.visible(name),
        `DISCOVERABILITY seam: ${name} is in neither this turn's schema nor the deferred manifest on a fully configured mailbox`,
      ).toBe(true);
    }
  });
});

// ── STATE 1: unconfigured ───────────────────────────────────────────────────

describe("email chain — unconfigured: only email_setup resolves", () => {
  it("resolves email_setup and NOTHING else in the family", async () => {
    const resolved = resolvedNames("send an email to bob and check my inbox");

    expect(
      resolved.has("email_setup"),
      "AVAILABILITY seam: email_setup went invisible on an unconfigured machine, so the user has no way back",
    ).toBe(true);
    for (const name of ALL_SEVEN) {
      expect(
        resolved.has(name),
        `AVAILABILITY seam: ${name} was resolved for a machine with no mailbox configured at all`,
      ).toBe(false);
    }
  });

  it("names none of them in the deferred manifest either — the lie must not just move", async () => {
    const seen = await observe();
    expect(seen.manifested.size, "MANIFEST seam: no manifest was emitted, so the assertions below prove nothing").toBeGreaterThan(0);
    for (const name of ALL_SEVEN) {
      expect(
        seen.manifested.has(name),
        `MANIFEST seam: ${name} is hidden from the schema but still named in the deferred manifest`,
      ).toBe(false);
    }
    expect(seen.visible("email_setup"), "MANIFEST seam: the one ungated email tool disappeared from both surfaces").toBe(true);
  });

  it("still refuses at execute(), because `available` is only advisory", async () => {
    // tool_search reaches a hidden tool by name (registry.search is deliberately
    // ungated), so the gate is NOT the guarantee — each execute() re-checks.
    loadMailbox();
    for (const name of IMAP_TOOLS) {
      const result = await call(name, { uids: [1000], uid: 1000, read: true, folder: "INBOX" });
      expect(result.isError, `CONFIG seam: ${name} ran against an unconfigured mailbox`).toBe(true);
      expect(String(result.content)).toMatch(/not configured/i);
    }
    expect(state.calls, "CONFIG seam: a refused call opened an IMAP connection anyway").toEqual([]);
  });
});

// ── STATE 2: send-only (legal because C7a made IMAP credentials optional) ────

/**
 * THE STATE MOST LIKELY TO BE SILENTLY BROKEN BY A FUTURE CHANGE. It is legal
 * only because the email declaration marks its IMAP credentials `required:
 * false`, and the natural "fix" — one email predicate for all seven tools —
 * makes a WORKING email_send vanish for a user who never configured reading.
 */
describe("email chain — send-only: email_send resolves, all five IMAP tools hide", () => {
  beforeEach(configureSmtp);

  it("resolves email_send and hides every IMAP tool", () => {
    const resolved = resolvedNames("send an email to bob and check my inbox");

    expect(
      resolved.has("email_send"),
      "AVAILABILITY seam: email_send was hidden from a user whose SMTP works — gating send on IMAP is the classic way to break this state",
    ).toBe(true);
    for (const name of IMAP_TOOLS) {
      expect(resolved.has(name), `AVAILABILITY seam: ${name} resolved with no IMAP configuration at all`).toBe(false);
    }
  });

  it("keeps the IMAP tools out of the deferred manifest too", async () => {
    const seen = await observe();
    expect(seen.manifested.size, "MANIFEST seam: no manifest was emitted, so the assertions below prove nothing").toBeGreaterThan(0);
    expect(
      seen.visible("email_send"),
      "MANIFEST seam: email_send works here and is in neither the schema nor the manifest",
    ).toBe(true);
    for (const name of IMAP_TOOLS) {
      expect(seen.manifested.has(name), `MANIFEST seam: ${name} is unusable here but still named in the manifest`).toBe(false);
    }
  });

  it("refuses every IMAP tool at execute() without opening a connection", async () => {
    loadMailbox();
    for (const name of IMAP_TOOLS) {
      const result = await call(name, { uids: [1000], uid: 1000, read: true, folder: "INBOX" });
      expect(result.isError, `CONFIG seam: ${name} ran on a send-only mailbox`).toBe(true);
    }
    expect(state.calls, "CONFIG seam: a send-only machine dialled an IMAP server").toEqual([]);
  });
});

// ── STATE 3: fully configured ───────────────────────────────────────────────

describe("email chain — fully configured: all seven resolve", () => {
  beforeEach(() => { configureSmtp(); configureImap(); });

  it("resolves all seven through the real per-request resolver", () => {
    const resolved = resolvedNames("send an email to bob and check my inbox");
    for (const name of ALL_SEVEN) {
      expect(resolved.has(name), `AVAILABILITY seam: ${name} stayed hidden on a fully configured mailbox`).toBe(true);
    }
  });

  it("registers each of the seven exactly once in the catalog the registry is built from", () => {
    for (const name of ALL_SEVEN) {
      expect(
        allTools.filter((t) => t.name === name).length,
        `BARREL seam: ${name} is registered ${allTools.filter((t) => t.name === name).length} times — a duplicate silently wins or loses at register() by insertion order`,
      ).toBe(1);
    }
  });
});

// ── THE JOURNEY: the thing the campaign exists for, in one test ──────────────

/**
 * "Delete everything from noreply@X older than a year."
 *
 * Every link is the production one and every input to a link is the OUTPUT of
 * the link before it — the uids handed to email_delete are the uids email_search
 * returned, and the Trash path is the one email_folders resolved by
 * `specialUse`. Nothing is hardcoded from the fixture into a later step, which
 * is the only way this proves composition rather than agreement.
 */
describe("email chain — the whole user journey, end to end", () => {
  beforeEach(() => { configureSmtp(); configureImap(); loadMailbox(); });

  it("searches with a date window, reads one in full, resolves Trash by role, deletes that uid, leaves everything else alone", async () => {
    // 1 ── SEARCH: sender + a date window, in one call.
    const searched = payloadOf(await call("email_search", {
      from: "noreply@vendor.test", before: "1 year", folder: "INBOX", limit: 50,
    }));
    const uids = (searched.messages as Array<{ uid: number; from: string }>).map((m) => m.uid);

    expect(
      searched.total,
      "SEARCH seam: the search reported a total of 0 — either the query compiler dropped every predicate or the page never came back",
    ).toBeGreaterThan(0);
    expect(uids, "SEARCH seam: the sender + date window did not select the two old newsletters").toEqual([1000, 1001]);
    expect(uids, "SEARCH seam: the `before` window was dropped — the RECENT message from the same sender came back too").not.toContain(1002);
    expect(uids, "SEARCH seam: the `from` predicate was dropped — another sender's mail came back").not.toContain(1003);
    expect(
      state.searchQueries[0],
      "SEARCH seam: the compiled query reached the server without a date bound, so the window was never applied server-side",
    ).toMatchObject({ from: "noreply@vendor.test" });
    expect((state.searchQueries[0] as { before?: unknown }).before, "SEARCH seam: `before` never became a Date in the compiled query").toBeInstanceOf(Date);

    // 2 ── READ ONE IN FULL, by a uid the search returned.
    const body = payloadOf(await call("email_read_message", { uid: uids[0], folder: "INBOX" }));
    expect(body.uid, "READ seam: email_read_message returned a different message than the uid asked for").toBe(uids[0]);
    expect(
      String(body.body),
      "READ seam: the full body is empty — the uid handed over by email_search did not resolve to a readable message",
    ).toContain("Unsubscribe");
    expect(body.contentType).toBe("text/plain");

    // 3 ── RESOLVE TRASH BY ROLE, not by name. The fixture's trash is "[Gmail]/Bin".
    const listed = payloadOf(await call("email_folders"));
    const folders = listed.folders as Array<{ path: string; specialUse: string | null }>;
    expect(folders.length, "FOLDERS seam: the folder list came back empty").toBeGreaterThan(0);
    const trash = folders.find((f) => f.specialUse === "\\Trash");
    expect(trash, "FOLDERS seam: no folder carries the RFC 6154 \\Trash role, so a delete has nowhere reversible to go").toBeTruthy();
    expect(
      trash!.path,
      "FOLDERS seam: Trash was resolved by NAME — this provider calls it Bin, which is the whole reason specialUse exists",
    ).toBe("[Gmail]/Bin");

    // 4 ── DELETE that exact uid, from that exact folder.
    const deleted = payloadOf(await call("email_delete", { uids: [uids[0]], folder: "INBOX" }));
    expect(deleted.destination, "DELETE seam: the move went somewhere other than the folder email_folders resolved").toBe(trash!.path);
    expect(deleted.source).toBe("INBOX");
    expect(deleted.confirmed, "DELETE seam: the server enumerated the move and the tool reported it as unconfirmed").toBe(true);
    expect(deleted.moved, "DELETE seam: exactly one message was requested and the confirmed count disagrees").toBe(1);
    expect(
      (deleted.messages as Array<{ uid: number; subject: string }>)[0],
      "DELETE seam: the payload does not NAME what it moved, so no caller can check it against what they meant to delete",
    ).toMatchObject({ uid: uids[0], subject: "Newsletter #1" });

    // 5 ── AND IT ACTUALLY LANDED, in Trash, with every other folder untouched.
    expect(inFolder("[Gmail]/Bin"), "DATA-LAYER seam: the message is not in Trash — a delete that reports success and moves nothing").toEqual([uids[0]]);
    expect(inFolder("INBOX"), "DATA-LAYER seam: the wrong set left INBOX").toEqual([1001, 1002, 1003]);
    expect(inFolder("receipts"), "DATA-LAYER seam: a delete scoped to INBOX touched `receipts`, which numbers its mail from the same uid").toEqual([1000, 1001]);
    expect(inFolder("[Gmail]/All Mail"), "DATA-LAYER seam: a delete scoped to INBOX touched another folder").toEqual([4000]);
    expect(state.moves, "DATA-LAYER seam: more than one move was issued for one delete").toEqual([
      { source: "INBOX", uids: [uids[0]], destination: "[Gmail]/Bin" },
    ]);
    expect(
      state.calls.filter((c) => /purge|expunge|store/i.test(c)),
      "E1 seam: a permanent-removal verb was issued — deletion is defined as a reversible move to Trash",
    ).toEqual([]);
  });

  it("marks the survivors read in the folder they came from, and moves nothing", async () => {
    const searched = payloadOf(await call("email_search", { from: "noreply@vendor.test", folder: "INBOX", limit: 50 }));
    const uids = (searched.messages as Array<{ uid: number }>).map((m) => m.uid);
    expect(uids.length, "SEARCH seam: nothing to mark, so this case proves nothing").toBeGreaterThan(0);

    const marked = payloadOf(await call("email_mark", { uids, read: true, folder: "INBOX" }));

    expect(marked.folder).toBe("INBOX");
    expect(state.flagOps, "MARK seam: the flag op did not reach the server as one scoped call").toEqual([
      { folder: "INBOX", uids, flags: ["\\Seen"], action: "add" },
    ]);
    expect(
      state.mailbox.INBOX.filter((m) => uids.includes(m.uid)).every((m) => m.seen),
      "DATA-LAYER seam: email_mark reported success and the server state did not change",
    ).toBe(true);
    expect(state.mailbox.receipts.every((m) => !m.seen), "MARK seam: another folder's mail was marked").toBe(true);
    expect(state.moves, "MARK seam: a mark moved mail").toEqual([]);
  });

  /**
   * THE UNFILTERED LIST, which is the other way into this chain: "what's in my
   * inbox" reaches email_read, not email_search, and its page is the input to
   * the same uids the mutating verbs take.
   *
   * The page size is the assertion. C1's headline defect was `fetchPage`
   * building its sequence range as the string `"*"` — the LAST message in IMAP —
   * so email_read returned exactly ONE message however large `limit` was, while
   * still reporting the mailbox's true total. Every state above this line stays
   * green with that bug restored, because none of them ever read a working
   * mailbox through this tool.
   */
  it("returns a PAGE of the newest messages, not the single last one — email_read against a real mailbox", async () => {
    const page = payloadOf(await call("email_read", { folder: "INBOX", limit: 3 }));
    const messages = page.messages as Array<{ uid: number; subject: string }>;

    expect(
      messages.length,
      "READ seam: email_read returned a different number of messages than `limit` allowed — a range anchored to \"*\" (the LAST message) returns exactly one here",
    ).toBe(3);
    expect(
      page.total,
      "READ seam: the page's `total` is not the mailbox's true size, so a caller cannot tell this page is partial",
    ).toBe(4);
    expect(page.truncated, "READ seam: 3 of 4 came back and the page did not say it was truncated").toBe(true);
    expect(
      messages.map((m) => m.uid),
      "READ seam: the page is not the NEWEST `limit` messages — \"the 3 oldest\" and \"the 3 newest\" are different mail once a caller deletes them",
    ).toEqual([1001, 1002, 1003]);
    expect(state.moves, "READ seam: a read moved mail").toEqual([]);
  });
});

// ── THE REFUSALS THAT STAND BETWEEN A MODEL'S SLIP AND THE MAILBOX ──────────

/**
 * Two layers upstream of the destructive verb whose ONLY job is to refuse, and
 * whose failure mode in both cases is to WIDEN the set the verb then acts on.
 * Neither is observable from a well-formed call, so a gate made only of
 * well-formed calls cannot see either one disappear.
 */
describe("email chain — the widening refusals, through the composed path", () => {
  beforeEach(() => { configureSmtp(); configureImap(); loadMailbox(); });

  /**
   * THE SINGLE GUARD BETWEEN THIS CAMPAIGN'S DESTRUCTIVE VERB AND A WHOLE
   * MAILBOX. `email_delete` has no required parameter — `required: []`, because
   * uids and filters are alternatives — so `email_delete({})` is a call the
   * schema permits and a model emits ("delete my emails"). Nothing in
   * email_delete itself refuses it: the empty criteria travel down to
   * buildSearchQuery, which throws SearchCriteriaError BEFORE a connection is
   * opened. Remove that throw and this call resolves Trash, matches the whole
   * INBOX and moves it, returning `{confirmed: true, moved: 3}` with no error.
   */
  it("refuses a delete with NO selector at all, rather than matching the whole mailbox", async () => {
    const result = await call("email_delete", {});

    expect(
      result.isError,
      "C1/C3 seam: email_delete with no uids and no filters was ACCEPTED — the empty-criteria refusal is the only thing standing between this verb and the entire mailbox",
    ).toBe(true);
    expect(
      String(result.content),
      "C1/C3 seam: the refusal does not say the criteria were empty, so the model cannot tell what to fix",
    ).toMatch(/entire mailbox/i);
    // C3's other half: this used to be classified by /mailbox|folder|select/i
    // over the message text, which this sentence matches, and came back as
    // "you picked a \Noselect container, retry against another folder" — a
    // false diagnosis whose suggested repair is wrong.
    expect(
      String(result.content),
      "C3 seam: the empty-criteria refusal was rewritten into the \\Noselect-container diagnosis again — a wrong cause with a wrong repair",
    ).not.toMatch(/containers that hold other folders/);

    expect(state.moves, "C1 seam: a delete that was supposed to be refused moved mail").toEqual([]);
    expect(state.calls, "C1 seam: the refusal ran a SEARCH — the compiler is supposed to throw before the query reaches the server").not.toContain("search");
    expect(inFolder("INBOX"), "C1 seam: THE WHOLE INBOX was moved out by a call with no selector").toEqual([1000, 1001, 1002, 1003]);
    expect(inFolder("[Gmail]/Bin"), "C1 seam: mail landed in Trash from a call with no selector").toEqual([]);
  });

  it("refuses a selector-less SEARCH from the same one definition", async () => {
    // Same compiler, same throw, surfaced by the read tool instead — so the two
    // verbs cannot drift into disagreeing about what "no filters" means.
    const result = await call("email_search", { folder: "INBOX" });

    expect(result.isError, "C1 seam: a search with no predicates was compiled instead of refused").toBe(true);
    expect(String(result.content)).toMatch(/entire mailbox/i);
    expect(state.searchQueries, "C1 seam: an unfiltered query reached the server").toEqual([]);
  });

  /**
   * THE ARGUMENT LAYER'S REFUSAL, which only a MALFORMED argument can observe.
   *
   * `before: 1785000000000` — epoch milliseconds — is the exact value C2 exists
   * to refuse. The old reader coerced any non-string to `""` and every caller
   * skipped falsy values, so the date window vanished with no error and no note.
   * That widens the match set, and this match set is what feeds the delete
   * above. Every other argument in this file is well-formed, so with that
   * silent drop restored the whole file stays green.
   */
  it("refuses a non-string date instead of silently dropping the window", async () => {
    const result = await call("email_search", { from: "noreply@vendor.test", before: 1785000000000 });

    expect(
      result.isError,
      "C2 seam: a numeric `before` was ACCEPTED — if it was dropped rather than refused, the date window silently vanished and the match set widened to every message from this sender",
    ).toBe(true);
    expect(
      String(result.content),
      "C2 seam: the refusal does not name the parameter and the form it wants, so the model cannot retry correctly",
    ).toMatch(/`before` must be a string/);
    expect(
      state.searchQueries,
      "C2 seam: the search was ISSUED — a query without the date bound the caller asked for is a wider set than was requested",
    ).toEqual([]);
    expect(state.calls, "C2 seam: an argument-layer refusal dialled the server").toEqual([]);
  });

  /**
   * And the same refusal on the DESTRUCTIVE verb, which is where the widening
   * actually costs something: a dropped `before` here is the difference between
   * trashing last year's newsletters and trashing every newsletter.
   */
  it("refuses a non-string date on the delete path too, and moves nothing", async () => {
    const result = await call("email_delete", { from: "noreply@vendor.test", before: 1785000000000 });

    expect(result.isError, "C2 seam: email_delete accepted a date it could not read").toBe(true);
    expect(String(result.content)).toMatch(/`before` must be a string/);
    expect(state.moves, "C2 seam: a delete whose date window was unreadable moved mail anyway").toEqual([]);
    expect(inFolder("INBOX")).toEqual([1000, 1001, 1002, 1003]);
    expect(state.calls, "C2 seam: an argument-layer refusal dialled the server").toEqual([]);
  });
});

// ── THE WRONG-TARGET GUARD, DRIVEN THROUGH THE REGISTRY ─────────────────────

/**
 * C3 closed this for email_delete and C7 closed it for email_mark. The guard was
 * proved by direct execute() calls in each chunk's own tests; what was NOT
 * proved is that it survives composition — that a model reaching these tools the
 * way the model actually reaches them still cannot retarget a uid list.
 *
 * `receipts` and INBOX both number their mail from 1000. That is the normal case
 * for two folders of similar age, not a contrived collision, and it is why an
 * existence check downstream cannot save this: the uids ARE present in INBOX,
 * they simply mean different mail.
 */
describe("email chain — uids from folder A cannot act on folder B", () => {
  beforeEach(() => { configureSmtp(); configureImap(); loadMailbox(); });

  /** Uids obtained from `receipts`, via the real search tool. */
  async function receiptUids(): Promise<number[]> {
    const page = payloadOf(await call("email_search", { from: "shop@store.test", folder: "receipts", limit: 50 }));
    const uids = (page.messages as Array<{ uid: number }>).map((m) => m.uid);
    expect(uids, "fixture drift: the collision this case rests on is gone").toEqual([1000, 1001]);
    return uids;
  }

  it("refuses a delete whose uids came from receipts and carry no folder", async () => {
    const uids = await receiptUids();
    const callsBefore = state.calls.length;

    const result = await call("email_delete", { uids });

    expect(result.isError, "GUARD seam: a uid list with no folder was accepted and INBOX was assumed").toBe(true);
    expect(String(result.content)).toMatch(/`uids` needs `folder`/);
    // The refusal is answerable from `args` alone, so it must land BEFORE the
    // folder list and the Trash lookup — the same order email_mark uses. That
    // is not decoration: while it ran after those, an account with no
    // resolvable Trash failed this call with the TRASH sentence, so this case
    // reddened without the provenance rule ever being reached and the evidence
    // said nothing about the guard.
    expect(
      state.calls.slice(callsBefore),
      "GUARD seam: a refusal decidable from the arguments alone opened a connection to inspect the target first",
    ).toEqual([]);
    expect(state.moves, "GUARD seam: mail was moved by a call that was supposed to be refused").toEqual([]);
    expect(inFolder("INBOX"), "GUARD seam: INBOX's 1000/1001 — different mail from a different sender — were trashed").toEqual([1000, 1001, 1002, 1003]);
    expect(inFolder("receipts")).toEqual([1000, 1001]);
    expect(inFolder("[Gmail]/Bin")).toEqual([]);
  });

  it("refuses a MARK whose uids came from receipts and carry no folder — C7 part 2", async () => {
    const uids = await receiptUids();

    const result = await call("email_mark", { uids, read: true });

    expect(result.isError, "GUARD seam: email_mark still defaults `folder` to INBOX — the asymmetry C3's skeptic recorded").toBe(true);
    expect(String(result.content)).toMatch(/`uids` needs `folder`/);
    expect(state.flagOps, "GUARD seam: a refused mark reached the server").toEqual([]);
    expect(state.mailbox.INBOX.every((m) => !m.seen), "GUARD seam: INBOX's mail was marked using receipts' uids").toBe(true);
  });

  it("refuses a delete that names the WRONG folder, listing the uids that are not there", async () => {
    // `[Gmail]/All Mail` holds uid 4000 only, so receipts' 1000/1001 are genuinely
    // absent and the existence check is the layer that catches it.
    const uids = await receiptUids();

    const result = await call("email_delete", { uids, folder: "[Gmail]/All Mail" });

    expect(result.isError, "GUARD seam: uids absent from the named folder were moved anyway").toBe(true);
    expect(
      String(result.content),
      "GUARD seam: the refusal does not NAME the uids that are not in that folder, so the caller cannot tell which folder it should have named — or it refused for some other reason entirely",
    ).toContain("1000, 1001");
    expect(state.moves).toEqual([]);
    expect(inFolder("[Gmail]/All Mail")).toEqual([4000]);
  });

  /**
   * THE FAMILY-WIDE INVARIANT, so the next uid-taking verb cannot quietly
   * reintroduce the default. Driven off the BARREL rather than a hand-written
   * list: a new tool added to email-tools.ts with a `uids` parameter is caught on
   * the commit that adds it, which a list of names could not do.
   */
  it("holds for EVERY uid-taking mutating verb in the barrel, present and future", async () => {
    const { emailTools } = await import("../src/tools/email-tools.js");
    const { isMutationTool } = await import("../src/tool-mutation-check.js");

    const uidTakers = emailTools.filter((t) => {
      const props = (t.parameters as { properties?: Record<string, unknown> }).properties ?? {};
      return "uids" in props && isMutationTool(t.name);
    });
    expect(
      uidTakers.map((t) => t.name).sort(),
      "INVARIANT seam: the set of uid-taking mutating verbs changed — extend the invariant deliberately, do not just update this list",
    ).toEqual(["email_delete", "email_mark"]);

    for (const tool of uidTakers) {
      const params = tool.parameters as { properties: Record<string, { description?: string }> };
      expect(
        params.properties.folder?.description ?? "",
        `INVARIANT seam: ${tool.name} takes \`uids\` but its \`folder\` parameter does not tell the model it is REQUIRED`,
      ).toMatch(/REQUIRED/);

      state.reset();
      loadMailbox();
      const result = await tool.execute({ uids: [1000, 1001], read: true });
      expect(
        result.isError,
        `INVARIANT seam: ${tool.name} accepted a uid list with no folder — uids are numbered per folder, so it acted on a set the caller never named`,
      ).toBe(true);
      expect(String(result.content), `INVARIANT seam: ${tool.name} refused for some other reason than the missing folder`).toMatch(/`uids` needs `folder`/);
      expect(state.moves, `INVARIANT seam: ${tool.name} moved mail on a call it refused`).toEqual([]);
      expect(state.flagOps, `INVARIANT seam: ${tool.name} flagged mail on a call it refused`).toEqual([]);
    }
  });

  it("does NOT require a folder on the FILTER path, where the uids are the search's own", async () => {
    // The rule is about uids a CALLER supplies. Filters resolve their own uids
    // inside the folder being searched, so there is no provenance to lose — and
    // over-applying the rule would make the common case harder for nothing.
    const result = payloadOf(await call("email_delete", { from: "alice@friend.test" }));
    expect(result.source, "GUARD seam: the filter path stopped defaulting to INBOX").toBe("INBOX");
    expect(inFolder("[Gmail]/Bin")).toEqual([1003]);
  });
});
