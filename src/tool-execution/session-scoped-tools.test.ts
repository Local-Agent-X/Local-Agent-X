// SESSION_SCOPED_TOOLS is a hand list that has to name every tool reading the
// trusted `_sessionId`. A model's own `_` keys are dropped at dispatch, so a
// reader left off the list never sees a session at all: restart, apply_update,
// op_kill, op_submit_batch, read_my_logs and protocol all had session branches
// nothing could reach. The contract below derives the readers from the
// registered tools' own execute bodies instead of trusting the list. It sees a
// direct read only; a tool that reads through a helper (restart and
// apply_update via resolveNotifyTarget) is pinned by the dispatch tests.

import { describe, it, expect } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ToolDefinition } from "../types.js";
import type { SecurityLayer } from "../security/index.js";
import type { ToolPluginContext } from "../tools/plugin.js";
import { allTools } from "../tools/registry-build.js";
import { plugins } from "../tools/plugins.js";
import { unifiedRegistry } from "../tools/registry.js";
import { builderToolsForTier } from "../tools/build-app-runtime.js";
import { createArikernelBridgeTools } from "../tools/arikernel-bridge.js";
import { createCoreProtocolTools } from "../protocols/index.js";
import { createProtocolFamilyTools } from "../protocols/protocol-tool.js";
import { collapseFamily } from "../tools/shared/collapse-family.js";
import { resolveNotifyTarget } from "../restart-notify.js";
import { buildMessagingSessionId } from "../session/channel-registry.js";
import { resolvePhase, SESSION_SCOPED_TOOLS } from "./resolve-tool.js";
import { createContext } from "./context.js";

// The set boot registers: the static catalog, every plugin, and the two paths
// that register after boot (app-build runtime tools, the ARI SQLite bridge).
async function registeredTools(): Promise<ToolDefinition[]> {
  const dataDir = mkdtempSync(join(tmpdir(), "lax-session-scoped-"));
  const ctx = {
    secretsStore: {},
    memoryIndex: {},
    cronService: {},
    dataDir,
    activeOnEventBySession: new Map(),
    activeBrowserSessionIdRef: { value: "" },
    activeRuntimeBySession: new Map(),
    registry: unifiedRegistry,
  } as unknown as ToolPluginContext;
  const tools: ToolDefinition[] = [...allTools];
  try {
    for (const plugin of plugins) tools.push(...await plugin.register(ctx));
    tools.push(...builderToolsForTier("full-stack"));
    tools.push(...createArikernelBridgeTools({ sqliteDatabase: {} as never }));
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
  return tools;
}

// A property read, not a mention: execute bodies keep their comments, and a
// comment naming the key reads nothing.
function readsSessionId(tool: ToolDefinition): boolean {
  return /\._sessionId\b/.test(String(tool.execute));
}

async function stampedArgs(name: string, sessionId: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const ctx = createContext({
    tc: { id: `call-${name}`, name, arguments: JSON.stringify(args) },
    toolMap: new Map(),
    security: {} as SecurityLayer,
    sessionId,
    callContext: "local",
  });
  expect((await resolvePhase(ctx)).kind).toBe("continue");
  return ctx.args;
}

describe("every tool that reads the trusted session is stamped with it", () => {
  it("registered tools whose execute reads `_sessionId`", async () => {
    const readers = [...new Set((await registeredTools()).filter(readsSessionId).map((tool) => tool.name))];
    // The scan has to see the readers it is guarding, or it proves nothing.
    expect(readers).toEqual(expect.arrayContaining(["op_kill", "op_submit_batch", "read_my_logs", "self_edit"]));
    expect(readers.filter((name) => !SESSION_SCOPED_TOOLS.has(name))).toEqual([]);
  });

  it("a collapsed family is stamped under its own name when an inner action reads the session", () => {
    const family = createProtocolFamilyTools()[0].name;
    const innerReaders = createCoreProtocolTools()
      .filter((tool) => tool.name.startsWith(`${family}_`) && readsSessionId(tool));
    expect(innerReaders.length).toBeGreaterThan(0);
    expect(SESSION_SCOPED_TOOLS.has(family)).toBe(true);
  });
});

describe("the stamp replaces whatever session the model names", () => {
  const SESSION = "session-scoped-trusted";

  it("each formerly unstamped reader receives the calling session", async () => {
    for (const name of [
      "restart", "apply_update", "op_kill", "op_submit_batch", "read_my_logs", "protocol",
      "run_build_plan", "build_plan_resume",
    ]) {
      const args = await stampedArgs(name, SESSION, { _sessionId: "someone-else" });
      expect(args._sessionId, name).toBe(SESSION);
    }
  });

  it("restart pings back on the channel the request came in on", async () => {
    const session = buildMessagingSessionId("telegram", "424242");
    const args = await stampedArgs("restart", session, { reason: "pick up new code" });
    expect(await resolveNotifyTarget(args)).toEqual({ channel: "telegram", target: "424242" });
  });

  it("a nested `params._sessionId` never reaches a protocol action", async () => {
    const args = await stampedArgs("protocol", SESSION, {
      action: "get",
      params: { name: "x", _sessionId: "someone-else" },
    });
    // The same merge the real family runs, with an action that records what
    // it receives in place of protocol_get's store lookups.
    const seen: Array<Record<string, unknown>> = [];
    const probe = collapseFamily({
      name: "protocol",
      intro: "probe",
      actions: {
        get: {
          name: "protocol_get", description: "probe.", parameters: { type: "object", properties: {} },
          execute: async (innerArgs) => { seen.push(innerArgs); return { content: "ok" }; },
        },
      },
    });
    await probe.execute(args);
    expect(seen).toEqual([expect.objectContaining({ name: "x", _sessionId: SESSION })]);
  });
});
