// The tool message's carry is the harness's channel for a result's status and
// block record; the rendered text is the model's. These hold the two apart:
// every message the pipeline emits carries its status, every reader takes the
// carry over the header, and the layer names the chat keys on are the ones the
// gates can produce.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
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
import type { ToolCallContext } from "./context.js";
import { showUnblockControlTool } from "../tools/unblock-control-tool.js";
import { activatePluginToolMetadata, deactivatePluginToolMetadata } from "../plugin-system/tool-metadata.js";
import { registerRedactedSecretValue, unregisterRedactedSecretValue } from "../security/secrets/index.js";
import { blockRecordOf, mediaRefOf, toolMessage, toolMessageMetadata, toolMessageResult, toolMessageStatus } from "./tool-message-carry.js";

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
    return msgs.filter((m) => m.role === "tool") as Array<{ content?: unknown; _status?: string; _block?: unknown; _metadata?: Record<string, unknown> }>;
  }

  it("the result's metadata rides the message through the pipeline", async () => {
    const [msg] = await dispatch(stub("carry_stub", ok("ran", { exit_code: 3, duration_ms: 12, sandboxMode: "guarded" })));
    expect(msg._metadata).toMatchObject({ exit_code: 3, duration_ms: 12, sandboxMode: "guarded" });
    const [plain] = await dispatch(stub("carry_stub", ok("fine")));
    expect(plain).not.toHaveProperty("_metadata");
  });

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

  it("a refusal from nowhere we can name reads as layer unknown, with a next step", () => {
    const plugin = { content: "nope", isError: true, status: "blocked", metadata: { recovery: "" } } as unknown as ToolResult;
    const record = blockRecordOf(plugin)!;
    expect(record.layer).toBe("unknown");
    expect(record.recovery).not.toBe("");
  });
});

// A plugin tool's refusal arrives with no layer; the dispatch boundary
// attributes it to the plugin that owns the tool, so the chat can say which
// one refused and the breaker groups by it. "unknown" is for a refusal with
// no owner at all.
describe("a plugin tool's refusal is attributed to the plugin", () => {
  beforeAll(() => setAriRequired(false));
  afterAll(() => setAriRequired(true));

  // The audit phase's attribution seam, driven directly: a plugin tool's
  // own refusal goes through the shell-class gates in a full dispatch, which
  // is a different test; this is the stamp and what the message carries.
  it("at the audit phase: layer plugin, with the owner's id on the record and the metadata", async () => {
    const { attributePluginRefusal } = await import("./audit-tool-call.js");
    const token = Symbol("weather-plugin");
    activatePluginToolMetadata("weather_lookup", { ownerId: "weather-plugin", activationToken: token, kernel: "shell", risk: "shell" });
    try {
      const refusal = { content: "nope: quota exceeded", isError: true, status: "blocked", metadata: { recovery: "" } } as unknown as ToolResult;
      const ctx = { tc: { id: "c-plugin", name: "weather_lookup", arguments: "{}" }, result: refusal } as unknown as ToolCallContext;
      attributePluginRefusal(ctx);
      const msg = toolMessage("c-plugin", ctx.result!) as { _block?: Record<string, unknown>; _metadata?: Record<string, unknown> };
      expect(msg._block).toMatchObject({ layer: "plugin", plugin: "weather-plugin" });
      expect(msg._metadata).toMatchObject({ layer: "plugin", plugin: "weather-plugin" });
      expect(toolMessageResult(msg as never).metadata?.layer).toBe("plugin");

      // Not a plugin tool: the stamp is not applied, the record reads unknown.
      const other = { tc: { id: "c-x", name: "carry_stub", arguments: "{}" }, result: refusal } as unknown as ToolCallContext;
      attributePluginRefusal(other);
      expect(blockRecordOf(other.result!)!.layer).toBe("unknown");
    } finally {
      deactivatePluginToolMetadata("weather_lookup", "weather-plugin", token);
    }
  });

  it("a refusal that already names its layer is left alone", () => {
    const record = blockRecordOf(blocked("no", { layer: "security", recovery: "Ask.", plugin: "weather-plugin" }))!;
    expect(record.layer).toBe("security");
    expect(record).not.toHaveProperty("plugin");
  });
});

describe("the whole metadata rides the message, scrubbed", () => {
  const shaped = "sk_live_" + "a".repeat(24);
  // A registered value with no catalog shape: the operator token's form.
  const known = createHash("sha256").update("carry-known-secret").digest("hex");

  it("every key is kept and every string, nested, goes through the secret redaction", () => {
    registerRedactedSecretValue(known);
    try {
      const message = toolMessage("c1", ok("done", {
        exit_code: 0, duration_ms: 12, truncated: false, recovery: "none needed",
        nested: { token: `Bearer ${shaped}`, count: 2 }, list: [shaped, 7], note: `use ${known} next`,
      }));
      const md = toolMessageMetadata(message)!;
      expect(Object.keys(md).sort()).toEqual(["duration_ms", "exit_code", "list", "nested", "note", "recovery", "truncated"]);
      expect(md.exit_code).toBe(0);
      expect(md.truncated).toBe(false);
      expect((md.nested as { count: number }).count).toBe(2);
      expect(JSON.stringify(md)).not.toContain(shaped);
      expect(JSON.stringify(md)).not.toContain(known);
      expect(md.recovery).toBe("none needed");
    } finally {
      unregisterRedactedSecretValue(known);
    }
  });

  it("stderr is dropped when the content already repeats it, kept when it does not", () => {
    // Longer than the header's 60-char cut, so only the body can repeat it.
    const stderr = "fatal: not a git repository (or any of the parent directories): .git — run git init first";
    const repeated = toolMessage("c2", { content: `out\n${stderr}`, isError: true, status: "error", metadata: { exit_code: 128, stderr } });
    expect(toolMessageMetadata(repeated)).toEqual({ exit_code: 128 });
    const separate = toolMessage("c3", { content: "Command timed out.", isError: true, status: "timeout", metadata: { duration_ms: 1000, stderr } });
    expect(toolMessageMetadata(separate)).toEqual({ duration_ms: 1000, stderr });
  });

  it("the accessor is undefined for a row written before the carry held it", () => {
    expect(toolMessageMetadata({ content: "[ok, exit_code=0]\nfine", _status: "ok" })).toBeUndefined();
    expect(toolMessageMetadata({ content: "legacy" })).toBeUndefined();
  });

  it("the carry is written by toolMessage() alone", () => {
    const offenders: string[] = [];
    for (const file of fg.sync(["src/**/*.ts"], { ignore: ["**/*.test.ts", "**/*.test-helper.ts", "**/vendor/**", CARRY] })) {
      const text = readFileSync(file, "utf8");
      // message-convert.ts rebuilds the carry from the row the dispatcher wrote;
      // it is the row's reader, not a second writer.
      if (/\b_metadata\s*=/.test(text) && !file.replace(/\\/g, "/").endsWith("chat-runner/message-convert.ts")) offenders.push(file);
    }
    expect(offenders).toEqual([]);
  });

  it("a media ref names the file under its route, never its path on disk", () => {
    expect(mediaRefOf({ kind: "image", path: "C:\\Users\\p\\ws\\images\\dog.png", mime: "image/png" })).toEqual({ kind: "image", name: "dog.png" });
    expect(mediaRefOf({ kind: "video", path: "/home/p/ws/videos/clip.mp4", mime: "video/mp4" })).toEqual({ kind: "video", name: "clip.mp4" });
    expect(mediaRefOf(undefined)).toBeUndefined();
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

  // Every quoted string the chat compares against a `layer` / `layers` value,
  // however it compares: `===` / `!==`, `.includes(...)` on a layers array or
  // on a named list, a `switch`, an index into a table. A regex for one
  // spelling let every other one escape.
  it("every layer the chat keys on, however it is compared, is one a gate produces", () => {
    const LAYER_REF = /\blayers?\b/;
    const named = new Map<string, string>();
    for (const file of fg.sync(["public/js/chat-*.js"])) {
      const source = ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
      const where = (node: ts.Node) => `${file.replace(/\\/g, "/")}:${source.getLineAndCharacterOfPosition(node.getStart()).line + 1}`;
      const lists = new Map<string, ts.ArrayLiteralExpression>();
      const literal = (n: ts.Node): string | undefined =>
        ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n) ? n.text : undefined;
      const name = (n: ts.Node, value: string | undefined) => { if (value !== undefined) named.set(value, where(n)); };
      const nameList = (arr: ts.ArrayLiteralExpression) => { for (const el of arr.elements) name(el, literal(el)); };
      const refersToLayer = (n: ts.Node) => LAYER_REF.test(n.getText());
      const visit = (node: ts.Node): void => {
        if (ts.isVariableDeclaration(node) && node.initializer && ts.isArrayLiteralExpression(node.initializer)) {
          lists.set(node.name.getText(), node.initializer);
          if (/layers?/i.test(node.name.getText())) nameList(node.initializer);
        }
        if (ts.isBinaryExpression(node) && [ts.SyntaxKind.EqualsEqualsEqualsToken, ts.SyntaxKind.ExclamationEqualsEqualsToken, ts.SyntaxKind.EqualsEqualsToken, ts.SyntaxKind.ExclamationEqualsToken].includes(node.operatorToken.kind)) {
          if (refersToLayer(node.left)) name(node.right, literal(node.right));
          if (refersToLayer(node.right)) name(node.left, literal(node.left));
        }
        if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
          const target = node.expression.expression;
          const method = node.expression.name.text;
          if (["includes", "indexOf", "has", "startsWith"].includes(method) && refersToLayer(target)) {
            for (const arg of node.arguments) name(arg, literal(arg));
          }
          if (["includes", "indexOf", "has"].includes(method) && node.arguments.some(refersToLayer)) {
            if (ts.isArrayLiteralExpression(target)) nameList(target);
            else if (ts.isIdentifier(target) && lists.has(target.text)) nameList(lists.get(target.text)!);
          }
        }
        if (ts.isSwitchStatement(node) && refersToLayer(node.expression)) {
          for (const clause of node.caseBlock.clauses) if (ts.isCaseClause(clause)) name(clause.expression, literal(clause.expression));
        }
        if (ts.isElementAccessExpression(node) && refersToLayer(node.argumentExpression) && ts.isObjectLiteralExpression(node.expression)) {
          for (const prop of node.expression.properties) if (prop.name) name(prop.name, literal(prop.name) ?? (ts.isIdentifier(prop.name) ? prop.name.text : undefined));
        }
        ts.forEachChild(node, visit);
      };
      visit(source);
    }
    // The comparisons the chat is known to make; the collector must see them.
    for (const known of ["arikernel", "quarantine-notice", "data-lineage", "tainted-shell"]) expect([...named.keys()], known).toContain(known);
    for (const [layer, at] of named) expect(BLOCK_LAYERS, `${layer} at ${at}`).toContain(layer);
  });

  it("every declared layer is produced somewhere, and 'unknown' by nothing", () => {
    for (const layer of BLOCK_LAYERS) {
      if (layer === "unknown") continue;
      expect(src.includes(`"${layer}"`), layer).toBe(true);
    }
    expect(src).not.toMatch(/layer: "unknown"/);
  });
});
