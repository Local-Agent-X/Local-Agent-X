// The tool message's carry is the harness's channel for a result's status and
// block record; the rendered text is the model's. These hold the two apart:
// every message the pipeline emits carries its status, every reader takes the
// carry over the header, and the layer names the chat keys on are the ones the
// gates can produce.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import fg from "fast-glob";
import ts from "typescript";
import type { ChatCompletionMessageParam } from "openai/resources/chat/completions.js";
import { BLOCK_LAYERS, type ToolDefinition, type ToolResult } from "../types.js";
import { blocked, ok } from "../tools/result-helpers.js";
import { setAriRequired } from "../ari-kernel/state.js";
import { _clearDedupCacheForTests } from "./dedup-cache.js";
import { executeToolCalls } from "./execute-tool.js";
import { markDryRunSession, unmarkDryRunSession } from "./resolve-tool.js";
import { showUnblockControlTool } from "../tools/unblock-control-tool.js";
import { blockRecordOf, toolMessage, toolMessageResult, toolMessageStatus } from "./tool-message-carry.js";

const CARRY = "src/tool-execution/tool-message-carry.ts";

function stub(name: string, result: ToolResult): ToolDefinition {
  return {
    name, description: "", parameters: { type: "object", properties: {} },
    readOnly: true, concurrencySafe: true,
    execute: async (): Promise<ToolResult> => result,
  } as unknown as ToolDefinition;
}

describe("every tool message the pipeline emits carries its status", () => {
  beforeAll(() => setAriRequired(false));
  afterAll(() => setAriRequired(true));

  async function dispatch(tool: ToolDefinition, opts: { sessionId?: string; priorMessages?: ChatCompletionMessageParam[] } = {}) {
    _clearDedupCacheForTests();
    const msgs = await executeToolCalls(
      [{ id: `c-${tool.name}`, name: tool.name, arguments: "{}" }],
      new Map([[tool.name, tool]]), undefined as never, undefined, undefined, undefined, undefined,
      opts.sessionId ?? "carry-test-session", undefined, undefined, opts.priorMessages, undefined, undefined, "api",
    );
    return msgs.filter((m) => m.role === "tool") as Array<{ content?: unknown; _status?: string; _block?: unknown }>;
  }

  it("a success, a failure, a refusal, a running start", async () => {
    const cases: Array<[ToolResult, string]> = [
      [ok("fine"), "ok"],
      [{ content: "boom", isError: true }, "error"],
      [blocked("no", { layer: "security", recovery: "Ask the user." }), "blocked"],
      [{ content: "started", status: "running", session_id: "s1" }, "running"],
    ];
    for (const [result, status] of cases) {
      const [msg] = await dispatch(stub("carry_stub", result));
      expect(msg._status, String(result.content)).toBe(status);
      expect(msg._block !== undefined, String(result.content)).toBe(status === "blocked");
    }
  });

  it("a session-repeat replay and a dry run — the two raw-text paths", async () => {
    const priorMessages = [
      { role: "assistant", content: null, tool_calls: [{ id: "p1", type: "function", function: { name: "carry_stub", arguments: "{}" } }] },
      { role: "tool", tool_call_id: "p1", content: "earlier", _status: "ok" },
    ] as unknown as ChatCompletionMessageParam[];
    const [replay] = await dispatch(stub("carry_stub", ok("fresh")), { priorMessages });
    expect(String(replay.content)).toContain("[REPEATED CALL");
    expect(replay._status).toBe("ok");

    markDryRunSession("carry-dry-run");
    try {
      const [dry] = await dispatch(stub("carry_stub", ok("never")), { sessionId: "carry-dry-run" });
      expect(String(dry.content)).toContain("[dry-run]");
      expect(dry._status).toBe("ok");
    } finally {
      unmarkDryRunSession("carry-dry-run");
    }
  });

  it("no tool message is built outside the carry module", () => {
    const offenders: string[] = [];
    for (const file of fg.sync(["src/tool-execution/**/*.ts", "src/tools/**/*.ts"], { ignore: ["**/*.test.ts", "**/*.test-helper.ts"] })) {
      const path = file.replace(/\\/g, "/");
      if (path === CARRY) continue;
      const source = ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true);
      const visit = (node: ts.Node): void => {
        if (ts.isPropertyAssignment(node) && node.name.getText() === "role" && ts.isStringLiteral(node.initializer) && node.initializer.text === "tool") {
          offenders.push(`${path}:${source.getLineAndCharacterOfPosition(node.getStart()).line + 1}`);
        }
        ts.forEachChild(node, visit);
      };
      visit(source);
    }
    expect(offenders, "build tool messages with toolMessage() so they carry their status").toEqual([]);
  });
});

describe("readers take the carry, and the header only for a row written before it", () => {
  it("the carry wins over the header", () => {
    expect(toolMessageStatus({ content: "[ok]\nfine", _status: "blocked" })).toBe("blocked");
    expect(toolMessageStatus({ content: "[error, exit_code=1]\nboom" })).toBe("error");
    expect(toolMessageStatus({ content: "plain legacy text" })).toBe("ok");
  });

  it("a refusal's envelope is rebuilt from its record: gate and next step", () => {
    const back = toolMessageResult(toolMessage("c1", blocked("no", { layer: "approval", recovery: "Ask.", deferredTo: "inb_1", clearable: "allow-host", host: "api.example.com" })));
    expect(back).toMatchObject({ status: "blocked", isError: true, metadata: { layer: "approval", recovery: "Ask.", deferredTo: "inb_1", clearable: "allow-host", host: "api.example.com" } });
    expect(toolMessageResult(toolMessage("c2", ok("fine")))).toEqual({ content: "fine", status: "ok", isError: false });
    expect(toolMessageResult(toolMessage("c3", { content: "started", status: "running", session_id: "s" })).isError).toBe(false);
  });

  it("a refusal from outside the type system reads as layer unknown, with a next step", () => {
    const plugin = { content: "nope", isError: true, status: "blocked", metadata: { recovery: "" } } as unknown as ToolResult;
    const record = blockRecordOf(plugin)!;
    expect(record.layer).toBe("unknown");
    expect(record.recovery).not.toBe("");
  });
});

describe("the re-surfaced control is a record on an ok result", () => {
  it("show_unblock_control's result carries the block record the chat renders the notice from", async () => {
    const { clearSessionTaint, getTaintSummary, recordSensitiveRead } = await import("../data-lineage/index.js");
    const sessionId = "carry-unblock-session";
    recordSensitiveRead(sessionId, "sensitive_file", "/home/u/.ssh/id_rsa");
    try {
      expect(getTaintSummary(sessionId).count).toBeGreaterThan(0);
      const result = await showUnblockControlTool.execute({ _sessionId: sessionId }, undefined as never);
      expect(result.status).toBe("ok");
      const message = toolMessage("c4", result) as { _status?: string; _block?: Record<string, unknown> };
      expect(message._status).toBe("ok");
      expect(message._block).toMatchObject({ layer: "quarantine-notice", clearable: "declassify", scope: "session-memory", notice: "declassify-card" });
      expect(message._block?.recovery).toBeUndefined();
    } finally {
      clearSessionTaint(sessionId);
    }
  });

  it("a plain ok result carries no record", () => {
    expect(toolMessage("c5", ok("fine", { layer: "security" }))).not.toHaveProperty("_block");
  });
});

describe("block layers are one closed set on both sides", () => {
  const src = fg.sync(["src/**/*.ts"], { ignore: ["**/*.test.ts", "**/*.test-helper.ts", "**/vendor/**"] }).map((f) => readFileSync(f, "utf8")).join("\n");

  it("every layer the chat keys on is one a gate produces", () => {
    const client = readFileSync("public/js/chat-declassify-action.js", "utf8");
    const named = new Set<string>();
    for (const m of client.matchAll(/md\.layer === '([^']+)'/g)) named.add(m[1]);
    for (const m of /LEGACY_TAINT_LAYERS = \[([^\]]*)\]/.exec(client)![1].matchAll(/'([^']+)'/g)) named.add(m[1]);
    expect(named.size).toBeGreaterThan(0);
    for (const layer of named) expect(BLOCK_LAYERS, layer).toContain(layer);
  });

  it("every declared layer is produced somewhere, and 'unknown' by nothing", () => {
    for (const layer of BLOCK_LAYERS) {
      if (layer === "unknown") continue;
      expect(src.includes(`"${layer}"`), layer).toBe(true);
    }
    expect(src).not.toMatch(/layer: "unknown"/);
  });
});
