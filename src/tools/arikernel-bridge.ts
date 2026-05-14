/**
 * AriKernel executor bridge — exposes the six vendored AriKernel executors
 * (file, http, shell, database, retrieval, sqlite-database) as SAX
 * ToolDefinitions in the unified registry. Closes DRY-AUDIT.md F2 part 2 by
 * removing the parallel "AriKernel dispatch path" — any SAX-side caller that
 * needs the kernel's I/O implementation now goes through `executeSingleTool`
 * via these adapter tools, and the AriKernel-specific safety properties
 * (capability tokens, taint labels, sandboxing) surface as fields on the
 * unified `ToolResult.metadata` envelope instead of a separate execution
 * stack.
 *
 * What's preserved:
 *   - Strong path-tainting on file ops (FileExecutor's O_NOFOLLOW + realpath
 *     verification + allowed-root check survive — the executor body runs
 *     unchanged after the unified pre-dispatch gate fires).
 *   - SSRF protections on http (HttpExecutor's URL-length guards, method
 *     enforcement, header inspection survive).
 *   - Shell sandboxing (ShellExecutor's metacharacter rejection, blocked
 *     interpreters, environment sanitization, cwd boundary survive).
 *   - Capability tokens — when a SAX caller wants kernel-side capability
 *     enforcement, it passes `_capabilityGrantId` in args; the adapter
 *     places it on the AriKernel ToolCall.grantId.
 *   - Taint labels — input taint passes through `_taintLabels`; output
 *     taint surfaces on `result.metadata.taintLabels`.
 */
import type { ToolCall, ToolClass, ToolResult as AriToolResult, TaintLabel } from "@arikernel/core";
import { generateId, now } from "@arikernel/core";
import {
  DatabaseExecutor,
  FileExecutor,
  HttpExecutor,
  RetrievalExecutor,
  ShellExecutor,
  SqliteDatabaseExecutor,
  type SqliteDatabase,
  type ToolExecutor,
} from "@arikernel/tool-executors";
import type { ToolDefinition, ToolResult } from "../types.js";

interface BridgeArgs {
  action?: string;
  _capabilityGrantId?: string;
  _taintLabels?: TaintLabel[];
  _principalId?: string;
  _runId?: string;
  [key: string]: unknown;
}

interface BridgeConfig {
  toolName: string;
  toolClass: ToolClass;
  description: string;
  defaultAction: string;
  executor: ToolExecutor;
}

const BRIDGE_INTERNAL_KEYS = new Set([
  "action",
  "_capabilityGrantId",
  "_taintLabels",
  "_principalId",
  "_runId",
  "_sessionId",
  "_onEvent",
  "_onProgress",
  "_cwd",
]);

function stripInternal(args: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(args)) {
    if (!BRIDGE_INTERNAL_KEYS.has(k)) out[k] = v;
  }
  return out;
}

function buildToolCall(cfg: BridgeConfig, args: BridgeArgs): ToolCall {
  return {
    id: generateId(),
    runId: args._runId ?? "sax-bridge",
    sequence: 0,
    timestamp: now(),
    principalId: args._principalId ?? "sax",
    toolClass: cfg.toolClass,
    action: args.action ?? cfg.defaultAction,
    parameters: stripInternal(args) as Record<string, unknown>,
    taintLabels: args._taintLabels ?? [],
    grantId: args._capabilityGrantId,
  };
}

function renderContent(toolName: string, ari: AriToolResult): string {
  if (!ari.success) return ari.error ? `${toolName} error: ${ari.error}` : `${toolName} failed`;
  if (ari.data === undefined || ari.data === null) return "";
  if (typeof ari.data === "string") return ari.data;
  try {
    return JSON.stringify(ari.data, null, 2);
  } catch {
    return String(ari.data);
  }
}

function toSaxResult(toolName: string, ari: AriToolResult): ToolResult {
  const content = renderContent(toolName, ari);
  const metadata: Record<string, unknown> = {
    arikernel: {
      callId: ari.callId,
      durationMs: ari.durationMs,
      taintLabels: ari.taintLabels,
    },
  };
  if (ari.success) {
    return { content, isError: false, status: "ok", metadata };
  }
  return {
    content,
    isError: true,
    status: "error",
    metadata: { ...metadata, recovery: "AriKernel executor rejected the call — see content for the reason." },
  };
}

function buildBridge(cfg: BridgeConfig): ToolDefinition {
  return {
    name: cfg.toolName,
    description: cfg.description,
    parameters: {
      type: "object",
      properties: {
        action: { type: "string", description: `AriKernel action (default: ${cfg.defaultAction})` },
      },
      additionalProperties: true,
    },
    async execute(args: Record<string, unknown>): Promise<ToolResult> {
      const tc = buildToolCall(cfg, args as BridgeArgs);
      try {
        const result = await cfg.executor.execute(tc);
        return toSaxResult(cfg.toolName, result);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        return {
          content: `${cfg.toolName} blocked: ${msg}`,
          isError: true,
          status: "blocked",
          metadata: { arikernel: { callId: tc.id, toolClass: cfg.toolClass } },
        };
      }
    },
  };
}

/**
 * Build the canonical six-executor bridge bundle. Each adapter wraps a
 * vendored executor; the unified registry is the single index the SAX
 * dispatcher consults to find them.
 */
export function createArikernelBridgeTools(options?: { sqliteDatabase?: SqliteDatabase }): ToolDefinition[] {
  const bridges: ToolDefinition[] = [
    buildBridge({
      toolName: "ari_file",
      toolClass: "file",
      description:
        "AriKernel file executor (kernel-side). Strong path-tainting via O_NOFOLLOW + realpath verification + allowed-root enforcement. Args: { action: 'read' | 'write', path, content?, encoding? }.",
      defaultAction: "read",
      executor: new FileExecutor(),
    }),
    buildBridge({
      toolName: "ari_http",
      toolClass: "http",
      description:
        "AriKernel HTTP executor (kernel-side). Method derived from action, URL-length cap, SSRF protections, header inspection. Args: { action: 'get'|'post'|..., url, headers?, body? }.",
      defaultAction: "get",
      executor: new HttpExecutor(),
    }),
    buildBridge({
      toolName: "ari_shell",
      toolClass: "shell",
      description:
        "AriKernel shell executor (kernel-side). Shell-metacharacter rejection, blocked interpreters, sanitized environment, cwd boundary. Args: { action: 'exec', executable, args[], cwd? } or { command, cwd? }.",
      defaultAction: "exec",
      executor: new ShellExecutor(),
    }),
    buildBridge({
      toolName: "ari_database",
      toolClass: "database",
      description:
        "AriKernel database executor (kernel-side stub). Validates structured intent for taint scoping; requires explicit 'table' for cross-principal tracking. Args: { action: 'query', table, database?, query?, connectionString? }.",
      defaultAction: "query",
      executor: new DatabaseExecutor(),
    }),
    buildBridge({
      toolName: "ari_retrieval",
      toolClass: "retrieval",
      description:
        "AriKernel retrieval executor (kernel-side). Auto-taints output with rag label so downstream propagation tracks retrieved content. Args: { action: 'search', query, ...}.",
      defaultAction: "search",
      executor: new RetrievalExecutor(),
    }),
  ];
  if (options?.sqliteDatabase) {
    bridges.push(
      buildBridge({
        toolName: "ari_sqlite",
        toolClass: "database",
        description:
          "AriKernel SQLite executor (kernel-side, structured). Real SQLite execution; parameterised queries, identifier allowlist, no raw SQL. Args: { action: 'query'|'mutate', table, ... }.",
        defaultAction: "query",
        executor: new SqliteDatabaseExecutor(options.sqliteDatabase),
      }),
    );
  }
  return bridges;
}
