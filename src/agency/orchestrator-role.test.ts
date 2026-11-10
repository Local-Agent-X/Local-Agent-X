import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Op } from "../ops/types.js";
import {
  applyFolderRule, orchestratorOf, releaseOrchestratorRole, repoKeyOfFolder, rolesOf, takeOrchestratorRole,
  _setOrchestratorFileForTest,
} from "./orchestrator-role.js";
import { leaveOwnCopy, ownCopyOf, _setOwnCopyFileForTest } from "./chat-own-copy.js";
import { recordClaims, _resetWorkClaimsForTest, _setWorkClaimsForTest } from "./work-claims.js";
import { notesSince, _resetHandoverNotesForTest, _setHandoverNotesForTest } from "./handover-notes.js";
import { _resetRepoLocateCacheForTest } from "./repo-locate.js";
import { otherAgentsSection, _resetOtherAgentsBlockForTest } from "./other-agents-block.js";
import { modelPinFromArg } from "../agents/spawn-model.js";

let repo: string;
let repoKey: string;
const moved: string[] = [];
const live = () => new Date(Date.now() + 60_000).toISOString();

beforeEach(() => {
  const root = mkdtempSync(join(tmpdir(), "lax-orch-"));
  repo = join(root, "repo");
  execFileSync("git", ["init", "-q", "-b", "main", repo]);
  const g = (...a: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", ...a], { cwd: repo });
  g("config", "user.name", "t"); g("config", "user.email", "t@t"); g("config", "commit.gpgsign", "false");
  writeFileSync(join(repo, "app.ts"), "one\n");
  g("add", "-A"); g("commit", "-q", "-m", "base");
  _setOrchestratorFileForTest(join(root, "orchestrators.json"));
  _setOwnCopyFileForTest(join(root, "session-worktrees.json"));
  _resetRepoLocateCacheForTest(); _resetOtherAgentsBlockForTest();
  _setWorkClaimsForTest({ dir: join(root, "holders"), readOp: (id) => ({ id, lane: id.startsWith("op-w") ? "agent" : "interactive", status: "running", task: `task of ${id}`, canonical: { leaseExpiresAt: live() } }) as unknown as Op });
  _setHandoverNotesForTest({ dir: join(root, "notes") });
  repoKey = repoKeyOfFolder(repo)!;
  moved.length = 0;
});
afterEach(() => {
  for (const s of moved) { try { leaveOwnCopy(s); } catch { /* already gone */ } }
  _setOrchestratorFileForTest(null); _setOwnCopyFileForTest(null); _resetWorkClaimsForTest(); _resetHandoverNotesForTest();
});

describe("the orchestrator role", () => {
  it("is one chat per repo, taken and released, with the user's model preferences kept", () => {
    expect(orchestratorOf(repoKey)).toBeNull();
    takeOrchestratorRole("chat-boss", repoKey, "Codex for UI, Claude for the server");
    expect(orchestratorOf(repoKey)).toMatchObject({ sessionId: "chat-boss", routing: "Codex for UI, Claude for the server" });
    // Taking it again without preferences keeps them; another chat taking it replaces the holder.
    takeOrchestratorRole("chat-boss", repoKey);
    expect(rolesOf("chat-boss")[0].routing).toBe("Codex for UI, Claude for the server");
    takeOrchestratorRole("chat-other", repoKey);
    expect(rolesOf("chat-boss")).toEqual([]);
    expect(releaseOrchestratorRole("chat-boss", repoKey)).toBe(false);
    expect(releaseOrchestratorRole("chat-other", repoKey)).toBe(true);
    expect(orchestratorOf(repoKey)).toBeNull();
  });

  it("tells the orchestrator chat who is working, where they overlap, how to delegate and what is not its call", () => {
    takeOrchestratorRole("chat-boss", repoKey, "Grok for research");
    recordClaims({ sessionId: "chat-a", opId: "op-a", paths: [join(repo, "src", "voice")], source: "declared", displayName: "Voice chat" });
    recordClaims({ sessionId: "agent-1", opId: "op-w1", paths: [join(repo, "src", "voice", "stt.ts")], source: "written", displayName: "Fix STT" });
    const brief = otherAgentsSection("chat-boss");
    expect(brief).toContain("--- ORCHESTRATOR ---");
    expect(brief).toContain("- Voice chat (chat, working now, in repo): task of op-a — changing src/voice — OVERLAPS Fix STT");
    expect(brief).toContain("The user's model preferences (follow them when you pick a model for a task): Grok for research");
    expect(brief).toContain("`touches` is the files or folders it will change, `model` is the model for that task");
    expect(brief).toContain("Never yours to decide: approving a risky action for another agent");
    // A chat without the role gets none of it.
    expect(otherAgentsSection("chat-a")).not.toContain("ORCHESTRATOR");
  });
});

describe("the orchestrator's rule: two chats never write one folder", () => {
  beforeEach(() => {
    recordClaims({ sessionId: "chat-first", opId: "op-first", paths: [join(repo, "app.ts")], source: "written", displayName: "First chat" });
  });

  it("moves the later chat to its own copy before it writes, and says so in a note", () => {
    takeOrchestratorRole("chat-boss", repoKey);
    moved.push("chat-second");
    const did = applyFolderRule("chat-second", repo, "Second chat");
    expect(did).toContain("Second chat now works in its own copy");
    expect(ownCopyOf("chat-second")).not.toBeNull();
    const notes = notesSince(repoKey);
    expect(notes).toHaveLength(1);
    expect(notes[0]).toMatchObject({ displayName: "Orchestrator", sessionId: "chat-boss" });
    expect(notes[0].text).toContain("First chat is writing this folder, and two agents never write one folder");
    // Applied once: the chat already has its copy.
    expect(applyFolderRule("chat-second", repo)).toBeNull();
  });

  it("does nothing without an orchestrator, for the orchestrator itself, or when nobody else writes the folder", () => {
    expect(applyFolderRule("chat-second", repo)).toBeNull();
    takeOrchestratorRole("chat-boss", repoKey);
    expect(applyFolderRule("chat-boss", repo)).toBeNull();
    expect(applyFolderRule("chat-first", repo)).toBeNull();
    expect(ownCopyOf("chat-boss")).toBeNull();
  });

  it("leaves a chat that already changed files in the shared folder where it is", () => {
    takeOrchestratorRole("chat-boss", repoKey);
    recordClaims({ sessionId: "chat-second", opId: "op-second", paths: [join(repo, "other.ts")], source: "written" });
    expect(applyFolderRule("chat-second", repo)).toBeNull();
    expect(ownCopyOf("chat-second")).toBeNull();
  });
});

describe("the model a task is given", () => {
  it("is written provider/model, and a bad one says what is wrong", () => {
    expect(modelPinFromArg(undefined)).toBeUndefined();
    expect(modelPinFromArg("xai/grok-4.3")).toEqual({ pin: { provider: "xai", model: "grok-4.3" } });
    expect(modelPinFromArg("local/qwen3.5:32b")).toEqual({ pin: { provider: "local", model: "qwen3.5:32b" } });
    expect(modelPinFromArg("skynet/t-800")).toHaveProperty("error");
    expect(modelPinFromArg("anthropic")).toHaveProperty("error");
    expect(modelPinFromArg(42)).toHaveProperty("error");
  });
});
