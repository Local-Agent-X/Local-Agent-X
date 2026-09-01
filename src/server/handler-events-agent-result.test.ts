import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { EventBus } from "../event-bus.js";
import type { LAXConfig, Session } from "../types.js";
import type { AgentRun, AgentRunStore, AgentTemplateStore } from "../agent-store/index.js";
import type { SessionStore, MemoryIndex } from "../memory/index.js";
import type { SecretsStore } from "../secrets.js";
import type { SecurityLayer } from "../security/index.js";
import type { ToolPolicy } from "../tool-policy/index.js";
import { registerAgentLifecycleEvents, isOrchestratorChild, type PendingAgentMeta } from "./handler-events-agent-result.js";
import { registerHandlerEvents } from "./handler-events.js";

// Regression (2026-08-30 overnight auto-build): every chunk / retry /
// preflight worker report landed in the user's chat as an assistant
// message because handler-events injected EVERY result whose spawn carried
// a parentSessionId — and the orchestrator threads the user's real chat
// session down to all its children. parentAgentId is the discriminator:
// orchestrator children carry the orchestrator op id, chat-initiated
// agent_spawn never sets it.

const CHAT = "chat-session-1";
const ORCH_OP = "orchestrator-op-77";

function harness() {
  const session: Session = { id: CHAT, title: "Chat", messages: [{ role: "user", content: "hi" }], createdAt: 1, updatedAt: 1 };
  const saved: Session[] = [];
  const runs: AgentRun[] = [];
  const broadcasts: Record<string, unknown>[] = [];
  const pendingMeta = new Map<string, PendingAgentMeta>();
  const sessionStore = { load: (id: string) => (id === CHAT ? session : null), save: (s: Session) => { saved.push(s); } };
  const agentRunStore = { save: (r: AgentRun) => { runs.push(r); } };
  const broadcastAll = (e: Record<string, unknown>) => { broadcasts.push(e); };
  return { session, saved, runs, broadcasts, pendingMeta, sessionStore, agentRunStore, broadcastAll };
}

function spawnEvent(agentId: string, parentAgentId: string | null, parentSessionId: string = CHAT) {
  return { agentId, name: "Researcher", role: "researcher", task: "Find issues", systemPrompt: "", parentSessionId, parentAgentId, templateId: null };
}

const completeOf = (broadcasts: Record<string, unknown>[]) => broadcasts.find(b => b.type === "agent-complete");
const spawnOf = (broadcasts: Record<string, unknown>[]) => broadcasts.find(b => b.type === "agent-spawn");

beforeEach(() => {
  EventBus.removeAllListeners("handler:agent-spawn");
  EventBus.removeAllListeners("handler:agent-result");
});

describe("isOrchestratorChild", () => {
  it("is true only for a non-empty parentAgentId", () => {
    expect(isOrchestratorChild({ parentAgentId: ORCH_OP })).toBe(true);
    expect(isOrchestratorChild({ parentAgentId: null })).toBe(false);
    expect(isOrchestratorChild({ parentAgentId: "" })).toBe(false);
  });
});

describe("handler:agent-result — orchestrator child (parentAgentId set)", () => {
  it("never injects the report into the parent chat, still persists the AgentRun", async () => {
    const h = harness();
    registerAgentLifecycleEvents({ eventBus: EventBus.getInstance(), ...h });
    await EventBus.emit("handler:agent-spawn", spawnEvent("run-1", ORCH_OP));
    await EventBus.emit("handler:agent-result", { agentId: "run-1", result: "STATUS: done\nDONE_WHEN: met", success: true, tokens: 12 });

    expect(h.session.messages).toHaveLength(1);
    expect(h.saved).toHaveLength(0);
    expect(h.runs).toHaveLength(1);
    expect(h.runs[0]).toMatchObject({ id: "run-1", parentAgentId: ORCH_OP, sessionId: CHAT, status: "succeeded", result: "STATUS: done\nDONE_WHEN: met", tokensUsed: 12 });
    expect(h.pendingMeta.has("run-1")).toBe(false);
  });

  it("stays out of the chat on failure too, and the AgentRun records the failure", async () => {
    const h = harness();
    registerAgentLifecycleEvents({ eventBus: EventBus.getInstance(), ...h });
    await EventBus.emit("handler:agent-spawn", spawnEvent("run-2", ORCH_OP));
    await EventBus.emit("handler:agent-result", { agentId: "run-2", result: "STATUS: blocked", success: false });

    expect(h.session.messages).toHaveLength(1);
    expect(h.saved).toHaveLength(0);
    expect(h.runs[0]).toMatchObject({ status: "failed", error: "STATUS: blocked" });
  });

  it("broadcasts agent-complete with sessionId + parentAgentId so the client can route/skip", async () => {
    const h = harness();
    registerAgentLifecycleEvents({ eventBus: EventBus.getInstance(), ...h });
    await EventBus.emit("handler:agent-spawn", spawnEvent("run-3", ORCH_OP));
    await EventBus.emit("handler:agent-result", { agentId: "run-3", result: "STATUS: done", success: true });

    expect(completeOf(h.broadcasts)).toMatchObject({ type: "agent-complete", agentId: "run-3", success: true, result: "STATUS: done", name: "Researcher", sessionId: CHAT, parentAgentId: ORCH_OP });
  });
});

describe("handler:agent-result — chat-initiated spawn (parentAgentId null)", () => {
  it("pushes the completed report into the parent chat in the pinned format", async () => {
    const h = harness();
    registerAgentLifecycleEvents({ eventBus: EventBus.getInstance(), ...h });
    await EventBus.emit("handler:agent-spawn", spawnEvent("run-4", null));
    await EventBus.emit("handler:agent-result", { agentId: "run-4", result: "Found 3 issues", success: true });

    expect(h.session.messages).toHaveLength(2);
    expect(h.session.messages[1]).toEqual({ role: "assistant", content: "**Agent Researcher completed:**\n\nFound 3 issues" });
    expect(h.session.updatedAt).toBeGreaterThan(1);
    expect(h.saved).toEqual([h.session]);
    expect(h.runs[0]).toMatchObject({ id: "run-4", parentAgentId: null, sessionId: CHAT, status: "succeeded" });
    expect(completeOf(h.broadcasts)).toMatchObject({ sessionId: CHAT, parentAgentId: null });
  });

  it("keeps the 'failed' label for a failed chat spawn", async () => {
    const h = harness();
    registerAgentLifecycleEvents({ eventBus: EventBus.getInstance(), ...h });
    await EventBus.emit("handler:agent-spawn", spawnEvent("run-5", null));
    await EventBus.emit("handler:agent-result", { agentId: "run-5", result: "Agent timed out", success: false });

    expect(h.session.messages[1]).toEqual({ role: "assistant", content: "**Agent Researcher failed:**\n\nAgent timed out" });
    expect(h.runs[0]).toMatchObject({ status: "failed", error: "Agent timed out" });
  });

  it("does not touch any session when the spawn had no parentSessionId", async () => {
    const h = harness();
    registerAgentLifecycleEvents({ eventBus: EventBus.getInstance(), ...h });
    await EventBus.emit("handler:agent-spawn", spawnEvent("run-6", null, ""));
    await EventBus.emit("handler:agent-result", { agentId: "run-6", result: "done", success: true });

    expect(h.saved).toHaveLength(0);
    expect(h.runs[0]).toMatchObject({ sessionId: "" });
    expect(completeOf(h.broadcasts)).toMatchObject({ sessionId: "", parentAgentId: null });
  });
});

describe("handler:agent-spawn broadcast", () => {
  it("always carries parentSessionId + parentAgentId, normalised", async () => {
    const h = harness();
    registerAgentLifecycleEvents({ eventBus: EventBus.getInstance(), ...h });
    await EventBus.emit("handler:agent-spawn", spawnEvent("run-7", ORCH_OP));
    expect(spawnOf(h.broadcasts)).toMatchObject({ type: "agent-spawn", agentId: "run-7", parentSessionId: CHAT, parentAgentId: ORCH_OP, rawName: "Researcher" });

    h.broadcasts.length = 0;
    // An emitter that omits both keys entirely (nothing in the spread).
    await EventBus.emit("handler:agent-spawn", { agentId: "run-8", name: "Researcher", role: "researcher", task: "t" });
    expect(spawnOf(h.broadcasts)).toMatchObject({ agentId: "run-8", parentSessionId: "", parentAgentId: null });
    expect(h.pendingMeta.get("run-8")).toMatchObject({ sessionId: "", parentAgentId: null });
  });

  it("a result with no recorded spawn still broadcasts, with empty routing keys and no persistence", async () => {
    const h = harness();
    registerAgentLifecycleEvents({ eventBus: EventBus.getInstance(), ...h });
    await EventBus.emit("handler:agent-result", { agentId: "ghost", result: "x", success: true });
    expect(completeOf(h.broadcasts)).toMatchObject({ agentId: "ghost", sessionId: "", parentAgentId: null });
    expect(h.runs).toHaveLength(0);
    expect(h.saved).toHaveLength(0);
  });
});

describe("registerHandlerEvents wiring", () => {
  afterEach(() => { EventBus.removeAllListeners(); });

  // The lifecycle listeners were split out of handler-events.ts; this pins
  // that registerHandlerEvents still installs them. Everything the driver
  // needs (config, security, stores…) is only read when a run is dispatched,
  // so empty stand-ins are enough here — no run is dispatched.
  it("installs the spawn/result listeners through the extracted module", async () => {
    const h = harness();
    registerHandlerEvents({
      config: {} as LAXConfig,
      dataDir: "/nonexistent",
      sessions: new Map<string, Session>(),
      sessionStore: h.sessionStore as unknown as SessionStore,
      memoryIndex: {} as MemoryIndex,
      secretsStore: {} as SecretsStore,
      security: {} as SecurityLayer,
      toolPolicy: {} as ToolPolicy,
      allAgentTools: [],
      agentRunStore: h.agentRunStore as unknown as AgentRunStore,
      agentTemplateStore: {} as AgentTemplateStore,
      broadcastAll: h.broadcastAll,
    });
    expect(EventBus.listenerCount("handler:agent-spawn")).toBe(1);
    expect(EventBus.listenerCount("handler:agent-result")).toBe(1);

    await EventBus.emit("handler:agent-spawn", spawnEvent("run-9", ORCH_OP));
    await EventBus.emit("handler:agent-result", { agentId: "run-9", result: "STATUS: done", success: true });
    expect(h.session.messages).toHaveLength(1);
    expect(h.runs).toHaveLength(1);

    await EventBus.emit("handler:agent-spawn", spawnEvent("run-10", null));
    await EventBus.emit("handler:agent-result", { agentId: "run-10", result: "ok", success: true });
    expect(h.session.messages[1]).toEqual({ role: "assistant", content: "**Agent Researcher completed:**\n\nok" });
  });
});
