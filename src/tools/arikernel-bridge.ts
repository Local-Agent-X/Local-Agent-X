/**
 * AriKernel executor bridge — exposes five vendored AriKernel executors
 * (file, http, database, retrieval, sqlite-database) as LAX
 * ToolDefinitions in the unified registry. Closes DRY-AUDIT.md F2 part 2 by
 * removing the parallel "AriKernel dispatch path" — any LAX-side caller that
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
 *   - Capability tokens — a kernel-side capability grant must be MINTED by a
 *     trusted server-side path, never declared by the model. The adapter
 *     therefore does NOT read `_capabilityGrantId` from args (a compromised
 *     model could otherwise forge a grant id). Until a trusted minting path is
 *     wired, ToolCall.grantId is left undefined and the kernel's own grant
 *     gate decides entitlement.
 *   - Taint labels — output taint surfaces on `result.metadata.taintLabels`.
 *     INPUT taint is injected by the runtime, not the caller: the model cannot
 *     self-declare (or self-clear) taint, so `_taintLabels` from args is
 *     ignored.
 *
 * Trust-critical envelope sanitization:
 *   The bridge derives runId / principalId / taint / grant from TRUSTED
 *   RUNTIME CONTEXT, never from `_`-prefixed model args. The runtime stamps a
 *   trusted `_sessionId` for these tools (each row `reads` "session");
 *   that — not the model-supplied `_runId`/`_principalId` — is what keys
 *   session-policy and run identity. Forged `_runId`/`_principalId`/
 *   `_capabilityGrantId`/`_taintLabels` are dropped for security decisions.
 *
 * The vendored ShellExecutor is deliberately not bridged: bash is the one
 * shell, and only bash carries path confinement, the sandbox cage, output
 * masking and taint — a second shell would be a way around all four.
 */
import type { ToolCall, ToolClass, ToolResult as AriToolResult, TaintLabel, TaintSource } from "@arikernel/core";
import { generateId, now } from "@arikernel/core";
import { getKernelTaintSources } from "../data-lineage/index.js";
import {
  DEFAULT_MAX_RESPONSE_SIZE,
  DatabaseExecutor,
  FileExecutor,
  HttpExecutor,
  RetrievalExecutor,
  SqliteDatabaseExecutor,
  type SqliteDatabase,
  type ToolExecutor,
} from "@arikernel/tool-executors";
import type { ToolDefinition, ToolResult } from "../types.js";
import { STAGE_RECOVERY } from "../tool-execution/stage-recovery.js";
import { sessionIdOf, withoutInternalArgs } from "../tool-execution/internal-args.js";
import { resolveAgentPath } from "../workspace/paths.js";
import { wrapExternalContent } from "../sanitize.js";
import { canonicalFetch } from "./web-egress.js";

interface BridgeArgs {
  action?: string;
  // Trusted runtime-injected context (the row `reads` "session").
  // This is the ONLY identity field the bridge trusts.
  _sessionId?: string;
  // Model-supplied `_`-fields. Present in the type so we can explicitly
  // STRIP them — they are never read for trust decisions. A compromised model
  // sets these to launder identity / capability / taint; the bridge ignores
  // them and derives everything from trusted context above.
  _capabilityGrantId?: string;
  _taintLabels?: TaintLabel[];
  _principalId?: string;
  _runId?: string;
  [key: string]: unknown;
}

export interface BridgeConfig {
  toolName: string;
  toolClass: ToolClass;
  description: string;
  defaultAction: string;
  executor: ToolExecutor;
  /** The result is off-box content (its row's externalContent): it reaches
   *  the model inside wrapExternalContent's boundary, like every network tool's. */
  externalContent?: true;
}

/**
 * ari_http's request, through the egress guard every other tool's fetch takes
 * (web-egress.ts canonicalFetch): DNS pinning, the private-address block over
 * every address form, the strict-mode allowlist, the outbound-bytes judge, and
 * a re-check per redirect. The kernel executor's own pinned request misses
 * NAT64 and 6to4 forms of a private address (ssrf.ts isPrivateIPv6), so a name
 * resolving to 64:ff9b::a9fe:a9fe reached the metadata address. The kernel
 * still runs its checks first: scheme, method from action, URL length, no body
 * on GET.
 */
async function guardedRequest(
  url: string, method: string, headers: Record<string, string>, body: string | undefined,
  timeoutMs: number, maxRedirects: number,
): Promise<{ status: number; headers: Record<string, string>; body: string }> {
  const res = await canonicalFetch(url, { method, headers, body, timeoutMs, maxRedirects });
  const out: Record<string, string> = {};
  res.headers.forEach((value, key) => { out[key] = value; });
  return { status: res.status, headers: out, body: (await res.text()).slice(0, DEFAULT_MAX_RESPONSE_SIZE) };
}

/** The executor's parameters: the model's arguments without the bridge's own
 *  `action` selector and without any `_` key — the server's stamps, and the
 *  forged identity a model might try (`_runId`, `_taintLabels`, …). */
function stripInternal(args: Record<string, unknown>): Record<string, unknown> {
  const { action: _action, ...rest } = withoutInternalArgs(args);
  return rest;
}

// The file executor resolves a relative path against the server's cwd, which
// is the install folder, while the gate it calls first (bootstrap-ari-gate.ts,
// then the read/write tools' declared path) resolves it from the workspace like
// every file tool. Handing the executor the path the gate resolves makes both
// judge and open the same file: "package.json" was judged as
// <workspace>/package.json and written to <install>/package.json.
function executorParameters(cfg: BridgeConfig, args: BridgeArgs): Record<string, unknown> {
  const params = stripInternal(args);
  if (cfg.toolClass === "file" && typeof params.path === "string" && params.path) {
    params.path = resolveAgentPath(params.path, sessionIdOf(args));
  }
  return params;
}

// Exported for the envelope-sanitization test (arikernel-bridge-envelope.test.ts):
// the trust-critical assertion is that this function derives runId/principal/
// taint/grant from trusted context only, never from forged model `_`-fields.
export function buildToolCall(cfg: BridgeConfig, args: BridgeArgs): ToolCall {
  // runId keys session-policy enforcement (bootstrap-ari-gate.ts), so it must
  // come from TRUSTED context — the runtime-stamped `_sessionId` — not from a
  // model-supplied `_runId` (which a compromised model could forge to launder
  // identity or slip a restrictive session policy). Fall back to a fresh id;
  // NEVER to a model-supplied value.
  const sessionId = sessionIdOf(args);
  const runId = sessionId ?? generateId();
  // Taint is injected by the runtime, not the caller. The model cannot
  // self-declare or self-clear taint, so `_taintLabels` is ignored. We look up
  // the live session's taint from the trusted data-lineage tracker, keyed off
  // the runtime-stamped `_sessionId` — so a sub-agent / prior sensitive read in
  // THIS session carries into the kernel's tainted-shell / tainted-egress rules.
  // Stays [] only when the session genuinely has no active taint.
  const taintLabels: TaintLabel[] = sessionId
    ? getKernelTaintSources(sessionId).map(source => ({
        source: source as TaintSource,
        origin: "runtime",
        confidence: 1.0,
        addedAt: now(),
      }))
    : [];
  return {
    id: generateId(),
    runId,
    sequence: 0,
    timestamp: now(),
    // No trusted principal is injected by the runtime today, so we fall back to
    // the generic "lax" principal. We deliberately do NOT read `_principalId`
    // from args — the model cannot impersonate a principal.
    principalId: "lax",
    toolClass: cfg.toolClass,
    action: args.action ?? cfg.defaultAction,
    parameters: executorParameters(cfg, args),
    taintLabels,
    // The kernel's policy verdict on this call was already given at dispatch:
    // the bridge's row is a gated class (file / http), so ariKernelGate ran
    // ariEvaluate with the host grants before execute. This executor call
    // performs the I/O; it never reads a `_capabilityGrantId` from args.
    grantId: undefined,
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

function toLaxResult(toolName: string, ari: AriToolResult): ToolResult {
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

const bridgeClassOf = new WeakMap<ToolDefinition, ToolClass>();

/** The kernel executor class a bridge tool runs on (its BridgeConfig), for the
 *  registry's class-keyed view; undefined for any other tool. */
export function kernelBridgeClass(tool: ToolDefinition): ToolClass | undefined {
  return bridgeClassOf.get(tool);
}

function buildBridge(cfg: BridgeConfig): ToolDefinition {
  const tool: ToolDefinition = {
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
        const result = toLaxResult(cfg.toolName, await cfg.executor.execute(tc));
        if (cfg.externalContent && !result.isError) {
          result.content = wrapExternalContent(result.content, cfg.toolName, { url: String(tc.parameters.url ?? "") });
        }
        return result;
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        return {
          content: `${cfg.toolName} blocked: ${msg}`,
          isError: true,
          status: "blocked",
          metadata: { layer: "arikernel", arikernel: { callId: tc.id, toolClass: cfg.toolClass }, recovery: STAGE_RECOVERY.arikernel },
        };
      }
    },
  };
  bridgeClassOf.set(tool, cfg.toolClass);
  return tool;
}

/**
 * Build the canonical five-executor bridge bundle. Each adapter wraps a
 * vendored executor; the unified registry is the single index the LAX
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
      executor: new HttpExecutor(guardedRequest),
      externalContent: true,
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
