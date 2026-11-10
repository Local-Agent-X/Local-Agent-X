import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Op } from "../ops/types.js";
import type { ToolCallContext } from "./context.js";
import { claimClashGate, recordWrittenClaims, _resetClaimClashGateForTest } from "./claim-clash-gate.js";
import { recordClaims, _resetWorkClaimsForTest, _setWorkClaimsForTest } from "../agency/work-claims.js";
import { postNote, _resetHandoverNotesForTest, _setHandoverNotesForTest } from "../agency/handover-notes.js";
import { locateInRepo, _resetRepoLocateCacheForTest } from "../agency/repo-locate.js";

let main: string;
let wt: string;
const ops = new Map<string, Partial<Op>>();
const live = () => new Date(Date.now() + 60_000).toISOString();

function ctxFor(sessionId: string, operationId: string, path: string): ToolCallContext {
  return {
    tc: { id: "t1", name: "write", arguments: "{}" },
    args: { path, content: "x" },
    sessionId, operationId,
  } as unknown as ToolCallContext;
}

beforeEach(() => {
  const root = mkdtempSync(join(tmpdir(), "lax-clash-"));
  main = join(root, "repo");
  mkdirSync(join(main, ".git", "worktrees", "wt1"), { recursive: true });
  writeFileSync(join(main, ".git", "worktrees", "wt1", "commondir"), "../..\n");
  wt = join(root, "wt1");
  mkdirSync(wt, { recursive: true });
  writeFileSync(join(wt, ".git"), `gitdir: ${join(main, ".git", "worktrees", "wt1")}\n`);
  ops.clear();
  ops.set("op-other", { id: "op-other", lane: "interactive", status: "running", task: "Rework the voice pipeline", canonical: { leaseExpiresAt: live() } as Op["canonical"] });
  ops.set("op-me", { id: "op-me", lane: "interactive", status: "running", task: "fix tests", canonical: { leaseExpiresAt: live() } as Op["canonical"] });
  _resetRepoLocateCacheForTest();
  _resetClaimClashGateForTest();
  _setWorkClaimsForTest({ dir: join(root, "holders"), readOp: (id) => (ops.get(id) as Op) ?? null });
  _setHandoverNotesForTest({ dir: join(root, "notes") });
  recordClaims({ sessionId: "chat-other", opId: "op-other", paths: [join(main, "src", "stt.ts")], source: "written", displayName: "Voice chat" });
});
afterEach(() => { _resetWorkClaimsForTest(); _resetHandoverNotesForTest(); });

describe("writing a file another live agent is changing", () => {
  it("in another checkout: runs, with a note naming them, their task and their latest note", () => {
    postNote({ sessionId: "chat-other", displayName: "Voice chat", repoKey: locateInRepo(join(main, "x"))!.repoKey, paths: ["src/stt.ts"], text: "moved VAD threshold to 0.6", kind: "agent" });
    const ctx = ctxFor("agent-1", "op-me", join(wt, "src", "stt.ts"));
    claimClashGate(ctx);
    expect(ctx.policyApprovalReason).toBeUndefined();
    expect(ctx.coordinationNote).toContain("`src/stt.ts` is also being changed by **Voice chat** (chat, working now)");
    expect(ctx.coordinationNote).toContain("Rework the voice pipeline");
    expect(ctx.coordinationNote).toContain('"moved VAD threshold to 0.6"');
    expect(ctx.coordinationNote).toContain("work_note");
  });

  it("in the same folder: asks the user, naming who and why", () => {
    const ctx = ctxFor("chat-me", "op-me", join(main, "src", "stt.ts"));
    claimClashGate(ctx);
    expect(ctx.policyApprovalReason).toMatch(/Voice chat \(chat, working now\) is changing `src\/stt.ts` in this same folder/);
    expect(ctx.policyApprovalReason).toContain("overwrite their unfinished edit");
  });

  it("asks once per turn: after the write went through, the next write there only notes", () => {
    const first = ctxFor("chat-me", "op-me", join(main, "src", "stt.ts"));
    claimClashGate(first);
    recordWrittenClaims(first, { content: "ok" });
    const second = ctxFor("chat-me", "op-me", join(main, "src", "stt.ts"));
    claimClashGate(second);
    expect(second.policyApprovalReason).toBeUndefined();
    expect(second.coordinationNote).toBeUndefined();
  });

  it("says nothing for a file nobody else claims, and records the writer's own claim", () => {
    const ctx = ctxFor("chat-me", "op-me", join(main, "src", "other.ts"));
    claimClashGate(ctx);
    expect(ctx.coordinationNote).toBeUndefined();
    recordWrittenClaims(ctx, { content: "ok" });
    const theirs = ctxFor("chat-other", "op-other", join(main, "src", "other.ts"));
    claimClashGate(theirs);
    expect(theirs.policyApprovalReason).toMatch(/is changing `src\/other.ts`/);
  });

  it("a failed write claims nothing", () => {
    const ctx = ctxFor("chat-me", "op-me", join(main, "src", "fail.ts"));
    recordWrittenClaims(ctx, { content: "no", isError: true });
    const theirs = ctxFor("chat-other", "op-other", join(main, "src", "fail.ts"));
    claimClashGate(theirs);
    expect(theirs.coordinationNote).toBeUndefined();
  });
});
