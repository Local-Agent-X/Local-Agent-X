import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// A chat's project folder is its own `folder` here; the real resolver only
// accepts folders inside the workspace, which a temp repo is not.
vi.mock("../../session/project-folder.js", () => ({ sessionProjectFolder: (s: { folder?: string }) => s.folder }));
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Op } from "../../ops/types.js";
import type { IncomingMessage, ServerResponse } from "node:http";
import { handleWorkClaimRoutes, othersInProjectOf, rowsOfChat, workClaimRows } from "./work-claims.js";
import { holderNamesFrom, recordClaims, taskTitle, _resetWorkClaimsForTest, _setWorkClaimsForTest } from "../../agency/work-claims.js";
import { ownCopyView } from "./own-copy.js";
import { clearSessionOwner, registerChildSessionOwner } from "../../browser/session-owner-registry.js";
import type { SessionMetadata } from "../../memory/session-metadata-cache.js";
import type { Session } from "../../types.js";
import { _resetRepoLocateCacheForTest } from "../../agency/repo-locate.js";

let repo: string;
beforeEach(() => {
  const root = mkdtempSync(join(tmpdir(), "lax-rows-"));
  repo = join(root, "repo");
  mkdirSync(join(repo, ".git"), { recursive: true });
  _resetRepoLocateCacheForTest();
  _setWorkClaimsForTest({ dir: join(root, "holders"), readOp: (id) => ({ id, lane: id === "op-w" ? "agent" : "interactive", status: "running", task: `task of ${id}`, canonical: { leaseExpiresAt: new Date(Date.now() + 60_000).toISOString() } }) as unknown as Op });
});
afterEach(() => _resetWorkClaimsForTest());

describe("GET /api/work-claims rows", () => {
  it("lists every live holder with its areas and who it overlaps", () => {
    recordClaims({ sessionId: "chat-a", opId: "op-a", paths: [join(repo, "src", "voice")], source: "declared", displayName: "Voice chat" });
    recordClaims({ sessionId: "agent-1", opId: "op-w", paths: [join(repo, "src", "voice", "stt.ts")], source: "written", displayName: "Fix STT" });
    recordClaims({ sessionId: "chat-c", opId: "op-c", paths: [join(repo, "docs", "a.md")], source: "written", displayName: "Docs" });
    const rows = Object.fromEntries(workClaimRows().map((r) => [r.sessionId, r]));
    expect(rows["chat-a"]).toMatchObject({ kind: "chat", state: "active", folder: "repo", areas: ["src/voice"], clashesWith: ["Fix STT"], task: "task of op-a" });
    expect(rows["agent-1"]).toMatchObject({ kind: "worker", opId: "op-w", areas: ["src/voice/stt.ts"], clashesWith: ["Voice chat"] });
    expect(rows["chat-c"].clashesWith).toEqual([]);
  });

  it("gives a chat the other agents in its project, flagged when they are in its files", () => {
    recordClaims({ sessionId: "chat-a", opId: "op-a", paths: [join(repo, "src", "voice")], source: "declared", displayName: "Voice chat" });
    recordClaims({ sessionId: "agent-1", opId: "op-w", paths: [join(repo, "src", "voice", "stt.ts")], source: "written", displayName: "Fix STT" });
    recordClaims({ sessionId: "chat-c", opId: "op-c", paths: [join(repo, "docs", "a.md")], source: "written", displayName: "Docs" });
    const others = othersInProjectOf("chat-a");
    expect(others.map((o) => [o.displayName, o.clashesWithMe]).sort()).toEqual([["Docs", false], ["Fix STT", true]]);
    expect(othersInProjectOf("chat-elsewhere")).toEqual([]);
  });

  // The panel's "This chat" view: the chat and the agents working for it.
  it("a chat's own rows are the chat and the agents it started, not another chat's", () => {
    recordClaims({ sessionId: "chat-a", opId: "op-a", paths: [join(repo, "src", "voice")], source: "declared", displayName: "Voice chat" });
    recordClaims({ sessionId: "agent-1", opId: "op-w", paths: [join(repo, "src", "voice", "stt.ts")], source: "written", displayName: "Fix STT" });
    recordClaims({ sessionId: "chat-c", opId: "op-c", paths: [join(repo, "docs", "a.md")], source: "written", displayName: "Docs" });
    registerChildSessionOwner("agent-1", "chat-a");
    try {
      expect(rowsOfChat("chat-a", workClaimRows()).map((r) => r.displayName).sort()).toEqual(["Fix STT", "Voice chat"]);
      expect(rowsOfChat("chat-c", workClaimRows()).map((r) => r.displayName)).toEqual(["Docs"]);
      expect(rowsOfChat("chat-elsewhere", workClaimRows())).toEqual([]);
    } finally {
      clearSessionOwner("agent-1");
    }
  });
});

// Live 2026-11-20: the strip named chats by the first words of the turn that
// started their work ("yes part of the repo"), never by their titles.
describe("the strip names chats as the chat list does", () => {
  const meta = (id: string, title: string, removedAt?: number): SessionMetadata =>
    ({ id, title, updatedAt: 1_000, messageCount: 2, ...(removedAt ? { removedAt } : {}) });

  it("by title, a worker by its task, and a deleted chat not at all", () => {
    recordClaims({ sessionId: "chat-a", opId: "op-a", paths: [join(repo, "src")], source: "written", displayName: "yes part of the repo" });
    recordClaims({ sessionId: "chat-gone", opId: "op-g", paths: [join(repo, "docs")], source: "written", displayName: "old words" });
    recordClaims({ sessionId: "agent-1", opId: "op-w", paths: [join(repo, "lib")], source: "written", displayName: "Fix STT" });
    const names = holderNamesFrom([meta("chat-a", "Delete member request"), meta("chat-gone", "Old chat", 2_000)]);
    const rows = workClaimRows(names);
    expect(rows.map((r) => r.displayName).sort()).toEqual(["Delete member request", "Fix STT"]);
    expect(othersInProjectOf("agent-1", names).map((o) => o.displayName)).toEqual(["Delete member request"]);
  });

  it("a chat writing a checkout of its own shares no folder with the chats in the project folder", () => {
    // A worktree of the same repo, laid out as git does: a `.git` file whose gitdir names the common dir.
    const own = join(repo, "..", "own-checkout");
    const gitdir = join(repo, ".git", "worktrees", "own");
    mkdirSync(gitdir, { recursive: true });
    mkdirSync(own, { recursive: true });
    writeFileSync(join(gitdir, "commondir"), "../..");
    writeFileSync(join(own, ".git"), `gitdir: ${gitdir}`);
    _resetRepoLocateCacheForTest();
    recordClaims({ sessionId: "chat-shared", opId: "op-s", paths: [join(repo, "a.ts")], source: "written", displayName: "Shared" });
    const ctx = { sessionStore: { load: (id: string) => ({ id, title: id, messages: [], createdAt: 0, updatedAt: 0, folder: repo }) as unknown as Session } };
    // Not written anywhere yet: its project folder is the one the others write.
    expect(ownCopyView(ctx as never, "chat-mine").sharesFolderWith).toEqual(["Shared"]);
    recordClaims({ sessionId: "chat-mine", opId: "op-m", paths: [join(own, "a.ts")], source: "written", displayName: "Mine" });
    expect(ownCopyView(ctx as never, "chat-mine").sharesFolderWith).toEqual([]);
  });
});

// Live 2026-11-21 (label-check): a build's worker, editing the project for the
// chat that started it, raised "same folder" on that chat; and a worker that
// had finished was still shown clashing with the one that retried its chunk.
describe("a chat's own build workers", () => {
  const ctx = () => ({ sessionStore: { load: (id: string) => ({ id, title: id, messages: [], createdAt: 0, updatedAt: 0, folder: repo }) as unknown as Session } });

  it("are not chats sharing its folder or clashing with it; another chat's worker still is", () => {
    recordClaims({ sessionId: "chat-a", opId: "op-a", paths: [join(repo, "package.json")], source: "written", displayName: "Build chat" });
    recordClaims({ sessionId: "agent-own", opId: "op-w", paths: [join(repo, "package.json")], source: "written", displayName: "Chunk 1/13: App skeleton" });
    recordClaims({ sessionId: "agent-other", opId: "op-w", paths: [join(repo, "package.json")], source: "written", displayName: "Someone else's worker" });
    registerChildSessionOwner("agent-own", "chat-a");
    try {
      expect(ownCopyView(ctx() as never, "chat-a").sharesFolderWith).toEqual(["Someone else's worker"]);
      const others = Object.fromEntries(othersInProjectOf("chat-a").map((o) => [o.sessionId, o.clashesWithMe]));
      expect(others).toEqual({ "agent-own": false, "agent-other": true });
      const row = workClaimRows().find((r) => r.sessionId === "chat-a")!;
      expect(row.clashesWith).toEqual(["Someone else's worker"]);
    } finally {
      clearSessionOwner("agent-own");
    }
  });

  // Shop Helper, 2026-11-27: chunks 2 and 3 were flagged "same files" for
  // different files in src/shared/, which the build merges itself.
  it("workers of one build are the build's to merge: no clash between them on the panel", () => {
    const build = (id: string) => id.startsWith("op-chunk");
    _setWorkClaimsForTest({
      dir: join(repo, "..", "holders"),
      readOp: (id) => ({ id, lane: id === "op-chat" ? "interactive" : "agent", status: "running", task: id, contextPack: { routing: { buildWorker: build(id) } }, canonical: { leaseExpiresAt: new Date(Date.now() + 60_000).toISOString() } }) as unknown as Op,
    });
    recordClaims({ sessionId: "agent-c2", opId: "op-chunk-2", paths: [join(repo, "src", "shared", "storeSchema.ts")], source: "declared", displayName: "Chunk 2/9" });
    recordClaims({ sessionId: "agent-c3", opId: "op-chunk-3", paths: [join(repo, "src", "shared")], source: "declared", displayName: "Chunk 3/9" });
    let rows = Object.fromEntries(workClaimRows().map((r) => [r.sessionId, r]));
    expect(rows["agent-c2"].clashesWith).toEqual([]);
    expect(rows["agent-c3"].clashesWith).toEqual([]);
    // Someone outside the build in the same folder is still shown, and as a folder.
    recordClaims({ sessionId: "chat-x", opId: "op-chat", paths: [join(repo, "src", "shared", "prompt.ts")], source: "written", displayName: "Your chat" });
    rows = Object.fromEntries(workClaimRows().map((r) => [r.sessionId, r]));
    expect(rows["agent-c3"]).toMatchObject({ clashesWith: ["Your chat"], clashScope: "folder" });
    // The same file is "files".
    recordClaims({ sessionId: "chat-x", opId: "op-chat", paths: [join(repo, "src", "shared", "storeSchema.ts")], source: "written", displayName: "Your chat" });
    rows = Object.fromEntries(workClaimRows().map((r) => [r.sessionId, r]));
    expect(rows["agent-c2"]).toMatchObject({ clashesWith: ["Your chat"], clashScope: "files" });
  });

  it("a worker that has finished clashes with nothing", () => {
    _setWorkClaimsForTest({
      dir: join(repo, "..", "holders"),
      readOp: (id) => ({ id, lane: "agent", status: id === "op-done" ? "completed" : "running", task: id, canonical: { leaseExpiresAt: new Date(Date.now() + 60_000).toISOString() } }) as unknown as Op,
    });
    recordClaims({ sessionId: "agent-first", opId: "op-done", paths: [join(repo, "package.json")], source: "written", displayName: "Chunk 1/13: App skeleton" });
    recordClaims({ sessionId: "agent-retry", opId: "op-live", paths: [join(repo, "package.json")], source: "written", displayName: "Chunk 1/13: App skeleton (retry)" });
    const rows = Object.fromEntries(workClaimRows().map((r) => [r.sessionId, r]));
    expect(rows["agent-first"]).toMatchObject({ state: "recent", clashesWith: [] });
    expect(rows["agent-retry"].clashesWith).toEqual([]);
  });

  // Live 2026-11-22: five finished build workers sat in the strip for two
  // hours, each named with the first 60 characters of its raw prompt.
  it("the route lists who is working, not a worker that has finished", async () => {
    _setWorkClaimsForTest({
      dir: join(repo, "..", "holders"),
      readOp: (id) => ({ id, lane: "agent", status: id === "op-done" ? "completed" : "running", task: id, canonical: { leaseExpiresAt: new Date(Date.now() + 60_000).toISOString() } }) as unknown as Op,
    });
    recordClaims({ sessionId: "agent-first", opId: "op-done", paths: [join(repo, "a.ts")], source: "written", displayName: "Chunk 1/13: App skeleton" });
    recordClaims({ sessionId: "agent-retry", opId: "op-live", paths: [join(repo, "b.ts")], source: "written", displayName: "Chunk 1/13: App skeleton (retry)" });
    let body = "";
    const res = { writeHead() { return res; }, setHeader() {}, end(b: string) { body = b; } } as unknown as ServerResponse;
    const ctx = { sessionStore: { list: () => [], load: () => null }, config: {} };
    await handleWorkClaimRoutes("GET", new URL("http://127.0.0.1/api/work-claims"), { headers: {} } as IncomingMessage, res, ctx as never, "operator" as never);
    expect((JSON.parse(body).holders as Array<{ sessionId: string }>).map((h) => h.sessionId)).toEqual(["agent-retry"]);
  });

  it("a worker nobody named is called by its task's first line, said once", () => {
    const prompt = "# Chunk 3/13: Matching\n\n## Working directory\nYour project root is: `C:/tmp/autobuild-c3`";
    _setWorkClaimsForTest({
      dir: join(repo, "..", "holders"),
      readOp: (id) => ({ id, lane: "agent", status: "running", task: prompt, canonical: { leaseExpiresAt: new Date(Date.now() + 60_000).toISOString() } }) as unknown as Op,
    });
    recordClaims({ sessionId: "agent-c3", opId: "op-c3", paths: [join(repo, "src", "match.ts")], source: "written" });
    const row = workClaimRows().find((r) => r.sessionId === "agent-c3")!;
    expect(row.displayName).toBe("Chunk 3/13: Matching");
    expect(row.task).toBe("");
    expect(taskTitle("\n\n  > quoted first\nsecond")).toBe("quoted first");
    expect(taskTitle("")).toBe("");
    // A chat keeps its message under its title; a row named after its own task does not repeat it.
    recordClaims({ sessionId: "chat-a", opId: "op-c3", paths: [join(repo, "docs", "a.md")], source: "written", displayName: "Label checker" });
    expect(workClaimRows().find((r) => r.sessionId === "chat-a")!.task).toContain("Chunk 3/13: Matching");
  });
});
