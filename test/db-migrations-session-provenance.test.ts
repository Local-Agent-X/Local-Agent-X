/**
 * Regression suite for migration v5 ("session-message-provenance") in
 * src/db-migrations.ts — the boot-time form of scripts/backfill-session-times.ts,
 * so every install is repaired on update, not only one where someone ran a
 * script.
 *
 *   - A re-stamped session (every row carrying its last save time, no ids) gets
 *     each matched turn's true time and op-store messageId back, the rest a
 *     minted id and the timeUnknown marker; every session log is backed up first.
 *   - The migration-version marker makes it one-shot.
 *   - An install with nothing to change is left alone: no backup, no rewrite.
 *   - An install with no sessions at all is fine.
 *
 * Seam notes mirror test/db-migrations-spend-budget.test.ts: fresh module per
 * test, LAX_DATA_DIR at a temp dir, so the real ~/.lax is never touched.
 */
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

type DbMigrations = typeof import("../src/db-migrations.js");
const tmpDirs: string[] = [];
let dataDir: string;
let runMigrations: DbMigrations["runMigrations"];

beforeEach(async () => {
  dataDir = mkdtempSync(join(tmpdir(), "db-migrations-provenance-"));
  tmpDirs.push(dataDir);
  process.env.LAX_DATA_DIR = dataDir;
  vi.resetModules();
  ({ runMigrations } = await import("../src/db-migrations.js"));
});
afterEach(() => { delete process.env.LAX_DATA_DIR; });
afterAll(() => { for (const d of tmpDirs) rmSync(d, { recursive: true, force: true }); });

const RESAVED = "2026-10-07T17:28:35.570Z";
function seedRestampedSession(): void {
  mkdirSync(join(dataDir, "sessions"), { recursive: true });
  const row = (message: object) => JSON.stringify({ kind: "msg", message, createdAt: RESAVED });
  writeFileSync(join(dataDir, "sessions", "chat-a.jsonl"), [
    JSON.stringify({ kind: "meta", id: "chat-a", title: "a", createdAt: Date.UTC(2026, 9, 5), updatedAt: 0 }),
    row({ role: "user", content: "car ride today" }),
    row({ role: "assistant", content: "the 2011 story?" }),
    row({ role: "user", content: "a voice turn with no op" }),
  ].join("\n") + "\n");
  const opDir = join(dataDir, "operations", "op_chat_turn_1");
  mkdirSync(opDir, { recursive: true });
  writeFileSync(join(opDir, "operation.json"), JSON.stringify({
    sessionId: "chat-a", task: "car ride today", createdAt: "2026-10-07T15:28:16.000Z", completedAt: "2026-10-07T15:28:30.000Z",
  }));
  const seed = (messageId: string, role: string, seqInTurn: number, text: string) => JSON.stringify({
    messageId, opId: "op_chat_turn_1", turnIdx: 0, seqInTurn, role, content: { text }, createdAt: "2026-10-07T15:28:16.000Z",
  });
  writeFileSync(join(opDir, "op-messages.jsonl"), [
    seed("um-op_chat_turn_1-init-a", "user", 0, "car ride today"),
    seed("am-op_chat_turn_1-1", "assistant", 1, "the 2011 story?"),
  ].join("\n") + "\n");
}
const msgRows = () => readFileSync(join(dataDir, "sessions", "chat-a.jsonl"), "utf8").split("\n").filter(Boolean)
  .map((l) => JSON.parse(l)).filter((r) => r.kind === "msg");
const backups = () => existsSync(join(dataDir, "backups")) ? readdirSync(join(dataDir, "backups")).filter((d) => d.startsWith("session-times-")) : [];

describe("migration v5 — session message provenance", () => {
  it("recovers times and op ids, marks the rest, backs up first, and records itself", async () => {
    seedRestampedSession();
    const result = await runMigrations(dataDir);
    expect(result.error).toBeUndefined();
    expect(result.applied.map((m) => m.version)).toContain(5);
    const [u, a, v] = msgRows();
    expect(u).toMatchObject({ id: "um-op_chat_turn_1-init-a", createdAt: "2026-10-07T15:28:16.000Z" });
    expect(a).toMatchObject({ id: "am-op_chat_turn_1-1", createdAt: "2026-10-07T15:28:30.000Z" });
    expect(v).toMatchObject({ createdAt: RESAVED, timeUnknown: true });
    expect(v.id).toMatch(/^sm-/);
    expect(backups()).toHaveLength(1);
  });

  it("is one-shot: a second boot does nothing", async () => {
    seedRestampedSession();
    await runMigrations(dataDir);
    const after = readFileSync(join(dataDir, "sessions", "chat-a.jsonl"), "utf8");
    vi.resetModules();
    const again = await (await import("../src/db-migrations.js")).runMigrations(dataDir);
    expect(again.applied).toEqual([]);
    expect(readFileSync(join(dataDir, "sessions", "chat-a.jsonl"), "utf8")).toBe(after);
  });

  it("leaves an already-repaired install alone: no backup, no rewrite", async () => {
    seedRestampedSession();
    const { planAllSessions, applyAllSessions } = await import("../src/memory/session-time-backfill.js");
    const { readOpMessages } = await import("../src/canonical-loop/index.js");
    applyAllSessions(dataDir, planAllSessions(dataDir, readOpMessages), "manual");
    const repaired = readFileSync(join(dataDir, "sessions", "chat-a.jsonl"), "utf8");
    rmSync(join(dataDir, "backups"), { recursive: true, force: true });
    const result = await runMigrations(dataDir);
    expect(result.applied.map((m) => m.version)).toContain(5);
    expect(backups()).toEqual([]);
    expect(readFileSync(join(dataDir, "sessions", "chat-a.jsonl"), "utf8")).toBe(repaired);
  });

  it("an install with no sessions is fine", async () => {
    const result = await runMigrations(dataDir);
    expect(result.error).toBeUndefined();
    expect(result.applied.map((m) => m.version)).toContain(5);
  });
});
