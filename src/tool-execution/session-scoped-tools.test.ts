// The run state the dispatcher stamps into a call is the tool's own policy
// row's `reads` (TrustedStamp, tool-policies.types.ts). A model's own `_` keys
// are dropped at dispatch, so a tool that reads a stamp its row does not
// declare never sees one: restart, apply_update, op_kill, op_submit_batch,
// read_my_logs and protocol all had session branches nothing could reach while
// the declaration was a hand list. The contract below derives the readers from
// the registered tools' own execute bodies and requires each to declare what
// it reads. It sees a direct read only; a tool that reads through a helper
// (restart and apply_update via resolveNotifyTarget) is pinned by the dispatch
// tests.

import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ToolDefinition } from "../types.js";
import type { SecurityLayer } from "../security/index.js";
import type { ToolPluginContext } from "../tools/plugin.js";
import type { TrustedStamp } from "../tool-policy/tool-policies.types.js";
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
import { setSessionProject } from "../session/project.js";
import { resolvePhase } from "./resolve-tool.js";
import { readsStamp, TOOL_PATH_ARGS, toolsWhere } from "../tool-registry.js";
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

// A read through the stamp's accessor (internal-args.ts) or a raw property
// read, not a mention: execute bodies keep their comments, and a comment
// naming the key reads nothing. The transformed source calls an imported
// accessor as `(0, ns.sessionIdOf)(args)`. `project` fills a model argument
// and has no accessor, so no body can be scanned for it.
const READ_OF: Record<Exclude<TrustedStamp, "project">, RegExp> = {
  session: /\._sessionId\b|sessionIdOf\)?\(/,
  operation: /\._operationId\b|operationIdOf\)?\(/,
  userMessage: /\._userMessageId\b|userMessageIdOf\)?\(/,
  lastTurn: /\._last(?:User|Assistant)Message\b|lastTurnOf\)?\(/,
  cwd: /\._cwd\b|cwdOf\)?\(/,
};
const STAMPS = Object.keys(READ_OF) as Array<keyof typeof READ_OF>;

const reads = (tool: ToolDefinition, stamp: keyof typeof READ_OF) => READ_OF[stamp].test(String(tool.execute));

async function stampedArgs(name: string, sessionId: string, args: Record<string, unknown>, operationId?: string): Promise<Record<string, unknown>> {
  const ctx = createContext({
    tc: { id: `call-${name}`, name, arguments: JSON.stringify(args) },
    toolMap: new Map(),
    security: {} as SecurityLayer,
    sessionId,
    operationId,
    callContext: "local",
  });
  expect((await resolvePhase(ctx)).kind).toBe("continue");
  return ctx.args;
}

describe("every tool that reads a trusted stamp declares it on its row", () => {
  it.each(STAMPS)("registered tools whose execute reads the %s stamp", async (stamp) => {
    const readers = [...new Set((await registeredTools()).filter((tool) => reads(tool, stamp)).map((tool) => tool.name))];
    const undeclared = readers.filter((name) => !readsStamp(name, stamp));
    expect(undeclared, `add "${stamp}" to \`reads\` on the tool's row in src/tool-policy/tool-policies.<domain>.ts`).toEqual([]);
  });

  it("the scan sees the readers it is guarding, or it proves nothing", async () => {
    const tools = await registeredTools();
    const readersOf = (stamp: keyof typeof READ_OF) => tools.filter((tool) => reads(tool, stamp)).map((tool) => tool.name);
    expect(readersOf("session")).toEqual(expect.arrayContaining(["op_kill", "op_submit_batch", "read_my_logs", "self_edit"]));
    expect(readersOf("operation")).toEqual(expect.arrayContaining(["ask_user", "show_unblock_control"]));
    expect(readersOf("userMessage")).toEqual(expect.arrayContaining(["remember"]));
    expect(readersOf("cwd")).toEqual(expect.arrayContaining(["bash"]));
  });

  it("every tool whose paths the file-access gate judges receives the session the gate resolved them with", async () => {
    const gated = Object.keys(TOOL_PATH_ARGS);
    expect(gated).toEqual(expect.arrayContaining(["view_image", "ocr", "document", "create_chart", "memory_ingest", "email_send"]));
    for (const name of gated) {
      const args = await stampedArgs(name, "path-gated-session", { _sessionId: "someone-else" });
      expect(args._sessionId, name).toBe("path-gated-session");
    }
  });

  it("a collapsed family declares every stamp an inner action reads, under its own name", () => {
    const family = createProtocolFamilyTools()[0].name;
    const inner = createCoreProtocolTools().filter((tool) => tool.name.startsWith(`${family}_`));
    const innerReads = STAMPS.filter((stamp) => inner.some((tool) => reads(tool, stamp)));
    expect(innerReads).toEqual(expect.arrayContaining(["session", "operation"]));
    for (const stamp of innerReads) expect(readsStamp(family, stamp), stamp).toBe(true);
  });
});

describe("the stamp replaces whatever the model names", () => {
  const SESSION = "session-scoped-trusted";

  afterEach(() => setSessionProject(SESSION, null));

  it("each formerly unstamped reader receives the calling session", async () => {
    for (const name of [
      "restart", "apply_update", "op_kill", "op_submit_batch", "read_my_logs", "protocol",
      "run_build_plan", "build_plan_resume",
    ]) {
      const args = await stampedArgs(name, SESSION, { _sessionId: "someone-else" });
      expect(args._sessionId, name).toBe(SESSION);
    }
  });

  it("a tool that reads the operation receives the calling op, never the model's", async () => {
    for (const name of toolsWhere((row) => row.reads?.includes("operation") === true)) {
      const args = await stampedArgs(name, SESSION, { _operationId: "forged-op" }, "op-trusted");
      expect(args._operationId, name).toBe("op-trusted");
    }
  });

  it("a tool that declares no session stamp is never handed one", async () => {
    expect(readsStamp("web_search", "session")).toBe(false);
    const args = await stampedArgs("web_search", SESSION, { query: "x" });
    expect(args._sessionId).toBeUndefined();
  });

  it("the session's project fills project_id only for a tool that declares it, and an explicit one wins", async () => {
    setSessionProject(SESSION, "proj-chat");
    expect((await stampedArgs("agent_spawn", SESSION, { task: "x" })).project_id).toBe("proj-chat");
    expect((await stampedArgs("agent_spawn", SESSION, { task: "x", project_id: "proj-named" })).project_id).toBe("proj-named");
    expect((await stampedArgs("op_submit_async", SESSION, { task: "x" })).project_id).toBeUndefined();
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
