// What LAX told the user, recalled from another chat on a real index: found
// by the one cross-session query, marked untrusted, and kept by the index sync.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MemoryIndex } from "./index.js";
import { indexInboxItem, inboxItemPath } from "./inbox-recall.js";
import { searchPastSessions } from "./tools/search/search-past-sessions.js";

let root: string;
let memory: MemoryIndex;
const prevHome = process.env.LAX_DATA_DIR;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "lax-inbox-recall-"));
  process.env.LAX_DATA_DIR = join(root, "data");
  memory = new MemoryIndex(join(root, "data"));
});
afterEach(() => {
  memory.close();
  if (prevHome === undefined) delete process.env.LAX_DATA_DIR; else process.env.LAX_DATA_DIR = prevHome;
  rmSync(root, { recursive: true, force: true });
});

const digest = {
  id: "inb_digest1",
  kind: "notice",
  title: "Mail digest: 26 messages that didn't need you right away",
  body: "• Academy Sports: Ends Tomorrow!\n• Kalshi: $25 bonus ends tomorrow\n• Erin McCoy: An update on Transformforfitness.Com",
  createdAt: Date.UTC(2026, 10, 14, 19, 0),
};

describe("inbox recall", () => {
  it("a chat finds what LAX told the user, with its contents, through the cross-session query", async () => {
    expect(await indexInboxItem(memory, digest)).toBeGreaterThan(0);
    const hits = await searchPastSessions(memory, "mail digest Transformforfitness", { sessionId: "whatsapp:+15550001" });
    const hit = hits.find((h) => h.path === inboxItemPath(digest.id));
    expect(hit, JSON.stringify(hits.map((h) => h.path))).toBeDefined();
    expect(hit!.snippet).toContain("Transformforfitness");
    expect(hit!.source).toBe("inbox");
  });

  it("is untrusted (it repeats mail text) and indexing the same item twice adds nothing", async () => {
    await indexInboxItem(memory, digest);
    expect(await indexInboxItem(memory, digest)).toBe(0);
    const [hit] = (await searchPastSessions(memory, "Kalshi bonus", {})).filter((h) => h.source === "inbox");
    expect(hit?.provenance?.trust_status ?? hit?.metadata?.trust_status).toBe("untrusted");
  });

  it("survives the index sync's sweep of paths with no file behind them", async () => {
    await indexInboxItem(memory, digest);
    memory.markDirty();
    await memory.sync();
    const hits = await searchPastSessions(memory, "mail digest Kalshi", {});
    expect(hits.some((h) => h.path === inboxItemPath(digest.id))).toBe(true);
  });
});
