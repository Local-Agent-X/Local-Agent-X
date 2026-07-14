/**
 * Cross-seam contract: archive → repoint → checkpoint → sync-sweep → search.
 *
 * Each piece is unit-tested in isolation (WAL checkpoint, embedding
 * reconcile, off-thread vector search, session archival, sweep exemption);
 * this proves the COMPOSITION on one real MemoryIndex over one real temp
 * dataDir. The lifecycle it guards: a session is indexed under the async
 * embedding path, memory-hygiene archives it (repointing its files row) and
 * truncates the WAL, the next sync's removed-path sweep runs — and the
 * archived session's embedded memory must still be findable by both the
 * hybrid search entry point and the C4 worker-thread vector scan. Any seam
 * drift (sweep stops exempting sessions-archive/, repoint wiring breaks,
 * checkpoint starts throwing under a live provider, vector rows stop
 * following the repointed chunks) fails here even if every unit test stays
 * green.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { existsSync, mkdtempSync, rmSync, mkdirSync, statSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemoryIndex, SessionStore } from "./index.js";
import { repointFile } from "./index-sync.js";
import { searchVectorOffThread } from "./index-search/vector-search.js";
import type { EmbeddingProvider } from "./types.js";
import type { Session } from "../types.js";

const DAY_MS = 24 * 60 * 60 * 1000;
const TOKEN = "zephyrquark"; // distinctive — findable by FTS and never elsewhere

function fakeProvider(): EmbeddingProvider {
  // Deterministic non-constant vectors so cosine scores are finite and real.
  const vec = (text: string) => {
    const out = new Array<number>(8).fill(0);
    for (let i = 0; i < text.length; i++) out[i % 8] += text.charCodeAt(i) / 1000;
    return out;
  };
  return {
    name: "fake", model: "m1", dimensions: 8,
    embed: async (text: string) => vec(text),
    embedBatch: async (texts: string[]) => texts.map(vec),
  };
}

let tempDir: string;
let memory: MemoryIndex;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "lax-hygiene-seam-"));
  mkdirSync(join(tempDir, "memory", "bank", "entities"), { recursive: true });
  mkdirSync(join(tempDir, "memory", "session-summaries"), { recursive: true });
  memory = new MemoryIndex(tempDir, { minScore: -1 });
});

afterEach(() => {
  try { memory.close(); } catch {}
  try { rmSync(tempDir, { recursive: true, force: true }); } catch {}
});

function walSize(): number {
  const p = join(tempDir, "memory.db-wal");
  return existsSync(p) ? statSync(p).size : 0;
}

describe("hygiene → search lifecycle (cross-seam contract)", () => {
  it("archived session's chunks survive checkpoint + sync sweep and stay searchable", async () => {
    const sessionId = "old-archived-session";
    const provider = fakeProvider();

    // C2/C3 seam: the async signature reconcile + vector-table init must
    // complete before indexing, exactly like boot does.
    await memory.setEmbeddingProvider(provider);

    const store = new SessionStore(tempDir);
    const session: Session = {
      id: sessionId,
      title: "Old session about zephyrquark",
      createdAt: Date.now() - 100 * DAY_MS,
      updatedAt: Date.now() - 100 * DAY_MS,
      messages: [
        { role: "user", content: `tell me about the ${TOKEN} protocol` },
        { role: "assistant", content: `The ${TOKEN} protocol is the archived-session marker for this contract test.` },
      ],
    };
    store.save(session);

    // Index the transcript through the real sync path (embeds via provider).
    memory.markDirty();
    await memory.sync();

    const db = memory.maintenanceDb();
    const livePath = join(tempDir, "sessions", `${sessionId}.jsonl`);
    const indexed = db.prepare("SELECT COUNT(*) AS n FROM chunks WHERE path = ? AND embedding IS NOT NULL").get(livePath) as { n: number };
    expect(indexed.n).toBeGreaterThan(0);

    // Age the transcript past the archival window (mtime drives the policy).
    const old = new Date(Date.now() - 100 * DAY_MS);
    utimesSync(livePath, old, old);

    // C6 seam: archive with the repoint callback wired exactly like
    // memory-hygiene.ts does.
    const r = store.archiveOldSessions(90, (oldPath, newPath) => {
      repointFile(memory.maintenanceDb(), oldPath, newPath);
    });
    expect(r).toEqual({ archived: 1, skipped: 0, failed: 0 });
    const archivedPath = join(tempDir, "sessions-archive", `${sessionId}.jsonl`);
    expect(existsSync(archivedPath)).toBe(true);
    expect(existsSync(livePath)).toBe(false);

    // C1 seam: checkpoint truncates the WAL the indexing pass grew — with a
    // live embedding provider attached and repointed rows in place.
    expect(walSize()).toBeGreaterThan(0);
    const cp = memory.checkpoint();
    expect(cp.busy).toBe(0);
    expect(cp.checkpointed).toBe(cp.log);
    expect(walSize()).toBe(0);

    // C5-adjacent seam: the next sync's removed-path sweep sees the live path
    // gone. The sessions-archive/ exemption must keep the repointed chunks.
    memory.markDirty();
    await memory.sync();

    const survived = db.prepare("SELECT COUNT(*) AS n FROM chunks WHERE path = ?").get(archivedPath) as { n: number };
    expect(survived.n).toBe(indexed.n);
    expect(db.prepare("SELECT 1 FROM files WHERE path = ?").get(archivedPath)).toBeTruthy();
    expect(db.prepare("SELECT 1 FROM files WHERE path = ?").get(livePath)).toBeFalsy();

    // Full search entry point (hybrid FTS + vector) still surfaces the
    // archived session's memory under its session scope.
    const results = await memory.search(TOKEN, { sessionId });
    expect(results.length).toBeGreaterThan(0);
    const hit = results.find((res) => res.path === archivedPath);
    expect(hit).toBeTruthy();
    expect(hit!.snippet).toContain(TOKEN);
    expect(hit!.metadata?.session_id).toBe(sessionId);

    // C4 seam: the worker-thread vector scan over the REAL on-disk db (a
    // second connection opened inside the worker) sees the archived chunks.
    const queryVec = await provider.embed(TOKEN);
    const vecHits = await searchVectorOffThread(db, queryVec, 10, undefined, sessionId);
    expect(vecHits.some((v) => v.path === archivedPath)).toBe(true);
  });
});
