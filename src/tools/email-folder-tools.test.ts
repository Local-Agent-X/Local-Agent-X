/**
 * Behaviour of `email_folders`, driven against a fake ImapFlow.
 *
 * The tool exists because `folder` is a free-text parameter on email_read and
 * email_search, so every assertion here is about what a caller can DO with the
 * output: pass a path straight back, and find Trash without matching on names.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

interface FakeFolder { path: string; name: string; specialUse?: string; subscribed: boolean }

const h = vi.hoisted(() => {
  const state = {
    folders: [] as FakeFolder[],
    calls: [] as string[],
    failList: false,
    reset(): void {
      state.folders = [];
      state.calls = [];
      state.failList = false;
    },
  };

  class FakeImapFlow {
    constructor(_opts: unknown) { state.calls.push("construct"); }
    async connect(): Promise<void> { state.calls.push("connect"); }
    async logout(): Promise<void> { state.calls.push("logout"); }
    close(): void { state.calls.push("close"); }
    async list(): Promise<unknown[]> {
      state.calls.push("list");
      if (state.failList) throw new Error("LIST refused");
      return state.folders;
    }
  }

  return { state, FakeImapFlow };
});

vi.mock("imapflow", () => ({ ImapFlow: h.FakeImapFlow }));

const state = h.state;

const { emailFolders } = await import("./email-folder-tools.js");

interface FolderOut { path: string; name: string; specialUse: string | null; subscribed: boolean }

const CFG = { host: "imap.example.com", user: "me@example.com", pass: "secret" };
const IMAP_ENV = ["IMAP_HOST", "IMAP_USER", "IMAP_PASS", "IMAP_PORT"];

let saved: Record<string, string | undefined>;
let dataDir: string;

beforeEach(() => {
  state.reset();
  saved = Object.fromEntries([...IMAP_ENV, "LAX_DATA_DIR"].map((k) => [k, process.env[k]]));
  dataDir = mkdtempSync(join(tmpdir(), "email-folders-"));
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

async function run(): Promise<{ folders: FolderOut[]; total: number }> {
  const result = await emailFolders.execute({});
  expect(result.isError).toBeFalsy();
  return JSON.parse(String(result.content));
}

const GMAIL: FakeFolder[] = [
  { path: "INBOX", name: "INBOX", subscribed: true },
  { path: "[Gmail]/All Mail", name: "All Mail", specialUse: "\\All", subscribed: true },
  { path: "[Gmail]/Sent Mail", name: "Sent Mail", specialUse: "\\Sent", subscribed: true },
  { path: "[Gmail]/Bin", name: "Bin", specialUse: "\\Trash", subscribed: true },
  { path: "receipts", name: "receipts", subscribed: true },
  { path: "old-project", name: "old-project", subscribed: false },
];

describe("email_folders", () => {
  it("returns paths a caller can pass straight to email_read's `folder`", async () => {
    state.folders = GMAIL;
    const payload = await run();
    const paths = payload.folders.map((f) => f.path);
    expect(paths).toContain("INBOX");
    expect(paths).toContain("[Gmail]/Bin");
    expect(paths).toContain("receipts");
    // Every entry carries a non-empty path, plus the context needed to choose.
    for (const f of payload.folders) {
      expect(typeof f.path).toBe("string");
      expect(f.path.length).toBeGreaterThan(0);
      expect(typeof f.subscribed).toBe("boolean");
      expect(f).toHaveProperty("specialUse");
    }
  });

  it("identifies Trash by specialUse, not by a name that says 'Trash'", async () => {
    // This provider calls it "Bin" and hangs it off a non-Gmail prefix, so any
    // caller matching on the string "Trash" finds nothing.
    state.folders = GMAIL;
    const payload = await run();
    const trash = payload.folders.filter((f) => f.specialUse === "\\Trash");
    expect(trash.map((f) => f.path)).toEqual(["[Gmail]/Bin"]);
    expect(payload.folders.some((f) => /trash/i.test(f.name))).toBe(false);
  });

  it("reports specialUse as null for ordinary folders rather than omitting it", async () => {
    state.folders = GMAIL;
    const payload = await run();
    const receipts = payload.folders.find((f) => f.path === "receipts");
    expect(receipts).toEqual({ path: "receipts", name: "receipts", specialUse: null, subscribed: true });
  });

  it("is unavailable when IMAP is not configured", () => {
    delete process.env.IMAP_HOST;
    expect(emailFolders.available?.()).toBe(false);
    process.env.IMAP_HOST = CFG.host;
    expect(emailFolders.available?.()).toBe(true);
  });

  it("surfaces the configuration error instead of connecting", async () => {
    delete process.env.IMAP_PASS;
    const result = await emailFolders.execute({});
    expect(result.isError).toBe(true);
    expect(String(result.content)).toMatch(/not configured/i);
    expect(state.calls).toEqual([]);
  });

  it("reports a failed LIST as an error rather than an empty account", async () => {
    state.folders = GMAIL;
    state.failList = true;
    const result = await emailFolders.execute({});
    expect(result.isError).toBe(true);
    expect(String(result.content)).toMatch(/LIST refused/);
  });

  it("closes the connection", async () => {
    state.folders = GMAIL;
    await run();
    expect(state.calls).toEqual(["construct", "connect", "list", "logout", "close"]);
  });
});

describe("email_folders ordering on a large account", () => {
  /** 120 labels, the shape of a real long-lived Gmail account. */
  function bigAccount(): FakeFolder[] {
    const labels: FakeFolder[] = Array.from({ length: 120 }, (_, i) => ({
      path: `label-${String(120 - i).padStart(3, "0")}`,
      name: `label-${String(120 - i).padStart(3, "0")}`,
      subscribed: i % 2 === 0,
    }));
    return [...labels, ...GMAIL.slice(0, 4)];
  }

  it("returns every folder — the one you need may be the one a cap would cut", async () => {
    state.folders = bigAccount();
    const payload = await run();
    expect(payload.folders).toHaveLength(124);
    expect(payload.total).toBe(124);
    expect(payload.folders.map((f) => f.path)).toContain("label-118");
  });

  it("puts INBOX first, then the special-use roles, so the useful ones are not buried", async () => {
    state.folders = bigAccount();
    const payload = await run();
    expect(payload.folders[0].path).toBe("INBOX");
    const roles = payload.folders.slice(1, 4).map((f) => f.specialUse);
    expect(roles.sort()).toEqual(["\\All", "\\Sent", "\\Trash"]);
  });

  it("orders the remaining folders by path, subscribed ones first", async () => {
    state.folders = bigAccount();
    const payload = await run();
    const rest = payload.folders.slice(4);
    const subscribed = rest.filter((f) => f.subscribed).map((f) => f.path);
    const unsubscribed = rest.filter((f) => !f.subscribed).map((f) => f.path);
    // Every subscribed folder precedes every unsubscribed one.
    expect(rest.map((f) => f.subscribed)).toEqual([
      ...subscribed.map(() => true), ...unsubscribed.map(() => false),
    ]);
    // …and each group is alphabetical, not server order (which was reversed).
    expect(subscribed).toEqual([...subscribed].sort());
    expect(unsubscribed).toEqual([...unsubscribed].sort());
  });
});
