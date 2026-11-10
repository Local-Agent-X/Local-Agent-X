import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Op } from "../ops/types.js";
import { getChatHandler, setChatHandler, type ChatHandler } from "../chat-ws/chat-handler.js";
import {
  raiseAboutOp, raiseClash, raiseToOrchestrator, wakeMessage,
  _flushOrchestratorWakeForTest, _resetOrchestratorWakeForTest,
} from "./orchestrator-wake.js";
import { repoKeyOfFolder, takeOrchestratorRole, _setOrchestratorFileForTest } from "./orchestrator-role.js";
import { recordClaims, _resetWorkClaimsForTest, _setWorkClaimsForTest } from "./work-claims.js";
import { _resetRepoLocateCacheForTest } from "./repo-locate.js";
import { assignableChats, pickChat, workAssignTool } from "./work-assign-tool.js";

let repo: string;
let repoKey: string;
let priorHandler: ChatHandler | null;
const sent: Array<{ sessionId: string; message: string }> = [];

beforeEach(() => {
  const root = mkdtempSync(join(tmpdir(), "lax-wake-"));
  repo = join(root, "repo");
  mkdirSync(join(repo, ".git"), { recursive: true });
  _setOrchestratorFileForTest(join(root, "orchestrators.json"));
  _resetRepoLocateCacheForTest(); _resetOrchestratorWakeForTest();
  _setWorkClaimsForTest({ dir: join(root, "holders"), readOp: (id) => ({ id, lane: id.startsWith("op-w") ? "agent" : "interactive", status: "running", task: `task of ${id}`, canonical: { leaseExpiresAt: new Date(Date.now() + 60_000).toISOString() } }) as unknown as Op });
  repoKey = repoKeyOfFolder(repo)!;
  sent.length = 0;
  priorHandler = getChatHandler();
  setChatHandler((sessionId, message) => { sent.push({ sessionId, message }); });
});
afterEach(() => {
  if (priorHandler) setChatHandler(priorHandler);
  _resetOrchestratorWakeForTest(); _setOrchestratorFileForTest(null); _resetWorkClaimsForTest();
});

describe("waking the orchestrator", () => {
  it("sends it one message for several events, marked as the app's and not the user's", () => {
    takeOrchestratorRole("chat-boss", repoKey);
    raiseToOrchestrator(repoKey, "a", "First thing happened.");
    raiseToOrchestrator(repoKey, "b", "Second thing\nhappened.");
    expect(sent).toEqual([]);
    _flushOrchestratorWakeForTest(repoKey);
    expect(sent).toHaveLength(1);
    expect(sent[0].sessionId).toBe("chat-boss");
    expect(sent[0].message).toBe(wakeMessage(["First thing happened.", "Second thing happened."]));
    expect(sent[0].message).toContain("This is not a message from the user.");
  });

  it("raises the same event once, and nothing in a project with no orchestrator", () => {
    raiseToOrchestrator(repoKey, "a", "Nobody is listening.");
    _flushOrchestratorWakeForTest(repoKey);
    expect(sent).toEqual([]);

    takeOrchestratorRole("chat-boss", repoKey);
    raiseToOrchestrator(repoKey, "x", "Once.");
    raiseToOrchestrator(repoKey, "x", "Once.");
    _flushOrchestratorWakeForTest(repoKey);
    expect(sent[0].message.match(/Once\./g)).toHaveLength(1);
  });

  it("hears of two agents in the same files, but not of a clash it is part of", () => {
    takeOrchestratorRole("chat-boss", repoKey);
    recordClaims({ sessionId: "chat-a", opId: "op-a", paths: [join(repo, "src", "x.ts")], source: "written", displayName: "Voice chat" });
    raiseClash(repoKey, "chat-a", "agent-1", "Fix STT", "src/x.ts", false);
    raiseClash(repoKey, "agent-1", "chat-a", "Voice chat", "src/x.ts", false);
    raiseClash(repoKey, "chat-boss", "chat-a", "Voice chat", "src/y.ts", true);
    _flushOrchestratorWakeForTest(repoKey);
    expect(sent).toHaveLength(1);
    expect(sent[0].message).toContain('- "Voice chat" and "Fix STT" are both changing src/x.ts.');
    expect(sent[0].message).not.toContain("src/y.ts");
    expect(sent[0].message.match(/both changing/g)).toHaveLength(1);
  });

  it("hears of a worker that stopped, by the worker's name", () => {
    takeOrchestratorRole("chat-boss", repoKey);
    recordClaims({ sessionId: "agent-1", opId: "op-w1", paths: [join(repo, "src", "x.ts")], source: "written", displayName: "Fix STT" });
    raiseAboutOp("op-w1", "suspended|op-w1", (name) => `"${name}" stopped making progress and is paused.`);
    _flushOrchestratorWakeForTest(repoKey);
    expect(sent[0].message).toContain('- "Fix STT" stopped making progress and is paused.');
  });
});

describe("handing a task to a chat already in the project", () => {
  beforeEach(() => {
    recordClaims({ sessionId: "chat-a", opId: "op-a", paths: [join(repo, "src", "x.ts")], source: "written", displayName: "Voice chat" });
    recordClaims({ sessionId: "agent-1", opId: "op-w1", paths: [join(repo, "src", "y.ts")], source: "written", displayName: "Fix STT" });
  });

  it("is refused for a chat that is not the orchestrator", async () => {
    const res = await workAssignTool.execute({ chat: "Voice chat", task: "do it", _sessionId: "chat-a" });
    expect(res.isError).toBe(true);
    expect(res.content).toContain("Only the project's orchestrator");
    expect(sent).toEqual([]);
  });

  it("reaches only chats working in the orchestrator's project, by name or id", () => {
    takeOrchestratorRole("chat-boss", repoKey);
    const chats = assignableChats("chat-boss");
    expect(chats.map((c) => c.sessionId)).toEqual(["chat-a"]);
    expect(pickChat(chats, "voice chat")).toMatchObject({ sessionId: "chat-a" });
    expect(pickChat(chats, "chat-a")).toMatchObject({ sessionId: "chat-a" });
    expect(pickChat(chats, "Fix STT")).toHaveProperty("error");
    expect((pickChat(chats, "nobody") as { error: string }).error).toContain('"Voice chat" (chat-a)');
  });
});
