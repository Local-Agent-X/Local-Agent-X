import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Op } from "../../ops/types.js";
import { othersInProjectOf, workClaimRows } from "./work-claims.js";
import { recordClaims, _resetWorkClaimsForTest, _setWorkClaimsForTest } from "../../agency/work-claims.js";
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
});
