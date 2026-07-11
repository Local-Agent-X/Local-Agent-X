// Sandboxed-execute phase: inject _onProgress, run tool.execute() with the
// transient-error retry policy, record sensitive reads, redact result content
// when taint fires (so the bytes never enter the LLM context — the egress
// gate would otherwise race the model's first sight of them), then record
// stats / circuit-breaker state / rate-limit consumption.

import type { ServerEvent, ToolResult } from "../types.js";
import { circuitArgsSig, recordCircuitFailure, recordCircuitSuccess } from "../circuit-breaker.js";
import { recordToolCall as recordToolStat } from "../tool-tracker.js";
import { recordToolCall as recordRateLimit } from "./rate-limiter.js";
import { recordSensitiveRead, isSensitivePath, extractSensitivePathsFromCommand, detectSecretsInOutput, redactSecretSpans } from "../data-lineage/index.js";
import { recordExternalIngestion, isExternalIngestingTool } from "../data-lineage/external.js";
import { hasCapability } from "../tool-registry.js";
import { createLogger } from "../logger.js";
import type { Phase } from "./context.js";
import { CONTINUE } from "./context.js";
import { RetryableToolResultError } from "../resilience-policy.js";
import { ToolTimeoutError } from "./tool-timeout.js";
import { timeout, blocked, ok } from "../tools/result-helpers.js";
import { resolveAgentPath } from "../workspace/paths.js";
import { isAbsolute } from "node:path";
import { realpathDeep, isSanctionedWorkRootEnvFile } from "../security/layer/index.js";
import { checkFreshness, recordFileSeen, unchangedSinceSeen, seenViewFromReadResult } from "../tools/read-state.js";
import { unattendedShellBlock } from "./unattended-shell-gate.js";
import { createToolRunner } from "./tool-runner.js";

const logger = createLogger("tool-execution");

// Edit-family tools that must not touch a file the session hasn't seen the
// current bytes of (stale-read guard). Read-before-edit, enforced at the layer
// that actually knows the session — not inside the tool, which doesn't.
const FRESHNESS_GUARDED: ReadonlySet<string> = new Set(["edit", "edit_lines", "multi_edit"]);
// Tools that leave the session knowing a file's current on-disk bytes.
const RECORDS_SEEN: ReadonlySet<string> = new Set(["read", "write", "edit", "edit_lines", "multi_edit"]);

// Sensitive-read tools whose taint is gated on the READ PATH (not on scanning
// returned content): a file read / pattern list. Their content scan is
// deliberately omitted to preserve canonical read/glob/grep behavior — output
// secret-scanning applies only to data-returning sensitive-read sinks.
const PATH_GATED_READS: ReadonlySet<string> = new Set(["read", "glob", "grep", "structural_search"]);

export const runSandboxedPhase: Phase = async (ctx) => {
  const { tc, tool, args, sessionId, signal, onEvent } = ctx;
  if (!tool) return CONTINUE;

  const shellBlock = unattendedShellBlock(tc.name, ctx.callContext);
  if (shellBlock) {
    ctx.result = shellBlock;
    return CONTINUE;
  }

  // Progress messages double as the timeout path's partial-output capture:
  // withTimeout orphans the execute promise on expiry, so whatever the tool
  // streamed via _onProgress is the only work product we can still surface
  // (metadata.partial_output on the [timeout] row). Bounded so a chatty
  // long-runner can't grow the buffer without limit.
  const progressLog: string[] = [];
  const onProgress = (message: string) => {
    progressLog.push(message);
    if (progressLog.length > 200) progressLog.shift();
    onEvent?.({ type: "tool_progress", toolName: tc.name, toolCallId: tc.id, message } as ServerEvent);
  };

  // Stale-read guard: refuse an edit against a file this session hasn't seen
  // the current bytes of. Runs before execute (and before circuit-breaker
  // accounting) so a "re-read first" never trips the breaker — it's guidance,
  // not a tool failure.
  if (typeof args.path === "string" && args.path && FRESHNESS_GUARDED.has(tc.name)) {
    // Path resolution / freshness is best-effort: a malformed path is the
    // tool's job to report, not ours to crash on, so swallow and fall through.
    let resolved: string | null = null;
    try { resolved = resolveAgentPath(args.path); } catch { /* let the tool handle it */ }
    const fresh = resolved ? checkFreshness(sessionId, resolved) : "ok";
    if (resolved && fresh !== "ok") {
      ctx.result = blocked(
        fresh === "unseen"
          ? `Refusing to edit ${resolved}: this session hasn't read it. Read the file first so your edit targets its current contents.`
          : `Refusing to edit ${resolved}: it changed on disk since this session last read it. Re-read it — your old_string or line numbers may be stale.`,
        { recovery: `Call read with path="${args.path}", then retry this edit.`, layer: "stale-read-guard" },
      );
      return CONTINUE;
    }
  }

  // Read-dedup: a full re-read of a file whose CURRENT disk bytes this session
  // provably already holds (hash-verified — mtime is only a prefilter) returns
  // a one-line stub instead of re-shipping the content. Partial/screened views
  // never dedup, an explicit offset/limit is the model's force-re-read lever,
  // and relative paths are exempt (their resolution can be work-root-dependent,
  // so only the session-independent absolute form is safe to stub). Runs before
  // execute and before accounting, like the freshness guard: a served stub is
  // guidance, not a tool run.
  if (tc.name === "read" && typeof args.path === "string" && args.path &&
      args.offset === undefined && args.limit === undefined && isAbsolute(args.path)) {
    let resolved: string | null = null;
    try { resolved = resolveAgentPath(args.path); } catch { /* let the tool handle it */ }
    if (resolved && unchangedSinceSeen(sessionId, resolved)) {
      ctx.result = ok(
        `Unchanged since this session last read it: ${resolved} (content-hash verified). ` +
        `Your existing view of this file is still current, so the re-read was skipped. ` +
        `To force a full re-read anyway, pass an explicit offset (e.g. offset=1).`,
        { path: resolved, unchanged: true },
      );
      return CONTINUE;
    }
  }

  const startedAt = Date.now();
  ctx.startedAt = startedAt;
  const runner = createToolRunner({ tool, args, operationId: ctx.operationId, toolCallId: tc.id, toolName: tc.name, sessionId, signal, onProgress });

  // ── Pre-execute taint FLOOR-set (R4-09 defense-in-depth) ─────────────────
  //
  // The egress gate (dataLineageGate) CHECKS the taint floor in the policy
  // phase; the sensitive-read taint WRITE used to happen only AFTER
  // ctx.result = await runOnce() below. Within one Promise.all batch sharing a
  // sessionId, a co-batched egress tool could therefore observe an EMPTY floor.
  // The batcher (executeToolCalls) already keeps egress and sensitive-read
  // tools in SEPARATE sequential batches — this is the second line of defense:
  // when the read is sensitive KNOWABLE FROM ARGS, set the floor synchronously
  // here, before execute, so the floor is up before any egress check can run.
  //
  // No content is passed (the bytes aren't read yet) — content fingerprints are
  // still added by the post-execute path below. The post-execute floor-set is
  // made idempotent against this pre-set so we don't accumulate a redundant
  // content-less entry for the same target.
  const isSensitiveReadCap = hasCapability(tc.name, "sensitive-read");
  let preTaintedPath: string | null = null;
  if (isSensitiveReadCap && tc.name !== "bash" && typeof args.path === "string" && args.path) {
    let taintPath: string;
    try {
      // sessionId parity with the sink: a work-rooted session's relative arg
      // must taint-resolve to the SAME inode the tool opens, not the default
      // anchor (the same split the round-3 anchor fix closed for the gate).
      taintPath = realpathDeep(resolveAgentPath(String(args.path), sessionId));
    } catch {
      taintPath = String(args.path);
    }
    // The sanctioned work-root env file skips the PATH-based pre-taint — the
    // post-execute check below taints it CONTENT-conditionally instead, so a
    // placeholder-only .env.local never bricks the shell but a real key
    // pasted into it still does.
    if (isSensitivePath(taintPath) && !isSanctionedWorkRootEnvFile(sessionId, taintPath)) {
      recordSensitiveRead(sessionId || "default", "sensitive_file", taintPath);
      preTaintedPath = taintPath;
    }
  } else if (tc.name === "bash") {
    const cmd = String(args.command || "");
    for (const p of extractSensitivePathsFromCommand(cmd)) {
      recordSensitiveRead(sessionId || "default", "sensitive_file", p);
    }
  }

  try {
    ctx.result = await runner.run();
    // Taint detection + result redaction.
    //
    // The taint model is "if you touched sensitive bytes, the whole session
    // is tainted for egress." dataLineageGate blocks the next egress call,
    // but the model has already SEEN the bytes once via ctx.result — and a
    // tainted model can include them in plain prose, future tool args, or
    // any channel the gate doesn't cover. So when taint fires we also
    // overwrite ctx.result.content with a stub: the gate prevents exfil AND
    // the redaction prevents the first sight.
    let redactReason: string | null = null;
    const isSensitiveRead = hasCapability(tc.name, "sensitive-read");
    // Path-carrying sensitive-read sinks (read, ari_file, glob, grep, …): a read
    // of a sensitive path taints + redacts. Was keyed to "read" only; now every
    // sensitive-read synonym that takes a `path` arg is covered the same way.
    if (isSensitiveRead && tc.name !== "bash" && args.path) {
      // Key the sensitivity check on the REALPATH of the arg, not the raw
      // innocent name (R4-19): a symlink `notes.txt → ~/.ssh/id_rsa` whose
      // lexical name is benign must still taint, because the bytes that reached
      // the model are the sensitive target's. realpathDeep follows every symlink
      // segment; ENOENT (path gone / never existed) falls back to the lexical
      // string so a non-existent sensitive literal still gets its check.
      const rawArgPath = String(args.path);
      // Resolve the arg the SAME way the file sinks do (project-root anchored)
      // BEFORE realpath, so a relative arg canonicalizes to the inode the tool
      // actually opened — not a cwd-relative miss.
      let taintPath: string;
      try {
        taintPath = realpathDeep(resolveAgentPath(rawArgPath, sessionId));
      } catch {
        taintPath = rawArgPath;
      }
      // The sanctioned work-root env file taints CONTENT-conditionally: a
      // structured secret shape (real API key / JWT / PEM) in its bytes taints
      // as usual, but placeholder-only content — the missing-creds recovery
      // path — must not brick the session's shell for reading its own scaffold.
      const fileContent = typeof ctx.result?.content === "string" ? ctx.result.content : undefined;
      const sanctionedEnv = isSanctionedWorkRootEnvFile(sessionId, taintPath);
      const envHoldsRealSecret = sanctionedEnv && !!fileContent && detectSecretsInOutput(fileContent).structured;
      if (isSensitivePath(taintPath) && (!sanctionedEnv || envHoldsRealSecret)) {
        // The FLOOR was already set pre-execute (preTaintedPath) so a co-batched
        // egress check couldn't see an empty floor. This post-execute record is
        // the content-bearing UPGRADE: pass the read content so the taint entry
        // carries fingerprints — lets a later egress block name which tainted
        // bytes are in the payload. Content is fingerprinted (hashed), never
        // stored as plaintext. Idempotency: if we already floor-set this exact
        // path AND there's no content to fingerprint, skip the duplicate (the
        // floor is presence-based, so a second content-less entry adds nothing).
        if (!(preTaintedPath === taintPath && !fileContent)) {
          recordSensitiveRead(sessionId || "default", "sensitive_file", taintPath, fileContent);
        }
        redactReason = `${tc.name} of sensitive path ${taintPath}`;
      }
    }
    if (tc.name === "bash") {
      const cmd = String(args.command || "");
      const matches = extractSensitivePathsFromCommand(cmd);
      if (matches.length > 0) {
        // The floor for these paths was already set pre-execute (synchronously
        // from the command args), so a co-batched egress check can't observe an
        // empty floor. We do NOT re-record here (the floor is presence-based and
        // these reads carry no per-path content to fingerprint) — just emit the
        // warn + redact stub as before.
        logger.warn(
          `bash command referenced sensitive paths; session ${sessionId || "default"} now tainted for egress`,
          { paths: matches },
        );
        redactReason = `bash command referenced sensitive path(s): ${matches.join(", ")}`;
      }
      const stdout = typeof ctx.result?.content === "string" ? ctx.result.content : "";
      // Only a SUCCESSFUL command's output is data the agent actually read; a
      // FAILED command's output is a diagnostic/error message. Don't taint on an
      // errored command — that was the over-block: a benign nonzero-exit bash
      // whose stderr carried a high-entropy build hash or a coincidental token
      // tripped the secret scanner, tainted the session, and (after the next
      // shell denial) locked the run out of editing the user's own app. A
      // successful `cat .env` (isError falsy) still taints. Mirrors the
      // web_fetch/http_request branch below, which already guards on !isError.
      if (stdout.length > 0 && ctx.result && !ctx.result.isError) {
        const det = detectSecretsInOutput(stdout);
        // Taint (and shell-block for the turn) only on a STRUCTURED credential —
        // a real API-key/PEM/JWT/known-value shape that genuinely surfaced a
        // secret to stdout. A high-entropy-ONLY match must NOT brick the shell:
        // the entropy pass fires on long camelCase identifiers and hashes in
        // ordinary source (live: `grep "as any"` over a real repo flagged hook
        // names like `useIframeNavigationApi` as "High-Entropy Token"), and
        // shell-block-on-taint would then wedge the primary coding workflow for
        // the whole turn. Real exfil of such a token is still caught at send time
        // by the egress guard AND the threat tool-chain's outbound scan (both key
        // on `matched`). Mirrors the web_fetch / errored-command tolerance below.
        if (det.structured) {
          recordSensitiveRead(sessionId || "default", "secret", `bash:${det.kinds.join(",")}`, stdout);
          logger.warn(
            `bash output contained secret-shaped content (kinds: ${det.kinds.join(", ")}) — session tainted`,
          );
          redactReason = `bash output contained secret-shaped content (${det.kinds.join(", ")})`;
        } else if (det.matched) {
          logger.debug(
            `bash output had a high-entropy-only match (kinds: ${det.kinds.join(", ")}) — not tainting (coincidental identifier/hash in source; egress + tool-chain still scan any outbound send)`,
          );
        }
      }
    }
    // Owned-source DATA reads (sql_query, email_read, memory_search, ari_file
    // read, ari_retrieval, ari_database, ari_sqlite) return row/record content
    // from a LOCAL or account-owned source. A secret stored there is OUR secret,
    // so a hit gets the full owned-source treatment: taint + whole-result redact.
    // Keyed on the sensitive-read CLASS (excluding bash — handled above — and the
    // path-listing read/glob/grep, whose existing behavior is path-gated only).
    if (isSensitiveRead && !PATH_GATED_READS.has(tc.name) && tc.name !== "bash") {
      const body = typeof ctx.result?.content === "string" ? ctx.result.content : "";
      if (body.length > 0) {
        const det = detectSecretsInOutput(body);
        // Memory results routinely contain UUIDs, hashes, tool-call ids, and
        // other long identifiers from old transcripts. The loose entropy pass
        // intentionally notices those for outbound scanning, but an
        // entropy-only hit is not enough evidence that memory_search surfaced a
        // credential. Treat it like bash output: only a structured credential
        // taints the session. Other owned sources keep the stricter historical
        // behavior because arbitrary high-entropy database/email values may be
        // account secrets.
        const shouldTaint =
          det.structured || (det.matched && tc.name !== "memory_search");
        if (shouldTaint) {
          recordSensitiveRead(sessionId || "default", "secret", `${tc.name}:${det.kinds.join(",")}`, body);
          logger.warn(
            `${tc.name} output contained secret-shaped content (kinds: ${det.kinds.join(", ")}) — session tainted`,
          );
          redactReason = `${tc.name} output contained secret-shaped content (${det.kinds.join(", ")})`;
        } else if (det.matched) {
          logger.debug(
            `${tc.name} output had a high-entropy-only match (kinds: ${det.kinds.join(", ")}) — not tainting (common transcript id/hash false positive)`,
          );
        }
      }
    }
    // web_fetch / http_request bodies are UNTRUSTED INBOUND content from the
    // public internet — NOT a secret this system owns. A secret-shaped span is
    // coincidental (a slug, a sample key in docs) or a prompt-injection payload.
    // Strip those spans from the model's view (so it can't echo/exfil them) but
    // KEEP the rest of the page and DON'T taint the session: blanket-redacting +
    // egress-blocking on a coincidental `sk-…` match bricked whole agent runs.
    // Exfil of OUR secrets is guarded by the owned-source branches above + the
    // egress allowlist — not by bytes arriving from a trade site.
    if (tc.name === "http_request" || tc.name === "web_fetch") {
      const body = typeof ctx.result?.content === "string" ? ctx.result.content : "";
      if (body.length > 0 && ctx.result && !ctx.result.isError) {
        const red = redactSecretSpans(body);
        if (red.matched) {
          ctx.result = { ...ctx.result, content: red.text };
          logger.warn(
            `${tc.name} response had secret-shaped span(s) redacted inline (kinds: ${red.kinds.join(", ")}) — not tainting (untrusted inbound source)`,
          );
        }
      }
    }

    // External-content ingestion mark (memory-promotion gate, NOT egress
    // taint). TOOL-CLASS keyed (D8): a successful result from an off-box-
    // ingesting tool (web_fetch/http_request/browser/search/mcp_*) means the
    // model is about to SEE external content this turn — mark the session so
    // the memory auto-promotion paths (auto-extract pre-flight, approval-phase
    // trusted-evidence downgrade) refuse durable writes: an LLM paraphrase of
    // injected material erases the content markers checkMemoryTaint keys on
    // (D6). Deliberately NOT content-sniffing the wrapExternalContent boundary
    // — that missed unwrapped browser reads (observe/evaluate/post-action
    // snapshots) and self-tainted any session that merely read a source file
    // containing the boundary literal.
    if (ctx.result && !ctx.result.isError && isExternalIngestingTool(tc.name)) {
      recordExternalIngestion(sessionId || "default");
    }

    if (redactReason && ctx.result && !ctx.result.isError) {
      const stub: ToolResult = {
        content:
          `[redacted by data-lineage gate — ${redactReason}. ` +
          `The raw bytes are withheld from the model context to prevent first-sight exfiltration; ` +
          `the session is now tainted and outbound egress tools are blocked for this session.]`,
        isError: false,
        status: "blocked",
        metadata: { layer: "data-lineage", redacted: true, reason: redactReason },
      };
      ctx.result = stub;
    }
  } catch (e) {
    const reconciliation = runner.reconcile(e);
    if (reconciliation) {
      ctx.result = reconciliation;
    } else if (e instanceof RetryableToolResultError) {
      ctx.result = e.result;
    } else if (e instanceof ToolTimeoutError) {
      // A hung tool: hand the model a hard [timeout] row so it can't narrate
      // "done" against silence. The execute promise is orphaned (no abort), so
      // tell the model to VERIFY state rather than assume success or failure.
      // Whatever the tool streamed via _onProgress before the deadline is the
      // one work product we still hold — surface it as partial_output (tail-
      // capped) instead of discarding it with the orphaned promise.
      const partial = progressLog.length > 0 ? progressLog.join("\n").slice(-4_000) : undefined;
      ctx.result = timeout(
        `Tool "${e.toolName}" exceeded its ${e.ms}ms timeout and was abandoned. It may still be running in the background.`,
        {
          duration_ms: e.ms,
          ...(partial ? { partial_output: partial } : {}),
          recovery:
            `Do NOT assume this succeeded or failed. Verify actual state before continuing: ` +
            `check process_status / process_list for a still-running process, and inspect the ` +
            `filesystem for any partial output. If the work is long-running, re-run it via an async tool (e.g. process_start / op_submit_async) and poll.`,
        },
      );
    } else {
      ctx.result = { content: `Tool error: ${(e as Error).message}`, isError: true };
    }
  }

  const result = ctx.result!;
  runner.complete(result);
  const durationMs = Date.now() - startedAt;
  const succeeded = !result.isError;
  if (succeeded && typeof args.path === "string" && args.path && RECORDS_SEEN.has(tc.name)) {
    // Reads record HOW the file was seen (partial/range views never dedup);
    // writes/edits pass no view — the session knows the whole resulting file,
    // and re-recording refreshes the diff snapshot to the post-edit bytes.
    const view = tc.name === "read" ? seenViewFromReadResult(args, result.metadata) : undefined;
    try { recordFileSeen(sessionId, resolveAgentPath(args.path), view); } catch { /* freshness is best-effort */ }
  }
  try { recordToolStat(tc.name, sessionId || "default", succeeded, durationMs, result.isError ? result.content?.slice(0, 200) : undefined); } catch { /* tracker should never break the call */ }
  try { recordRateLimit(tc.name, sessionId); } catch { /* same */ }
  if (succeeded) {
    recordCircuitSuccess(sessionId, tc.name, circuitArgsSig(tc.arguments));
  } else {
    recordCircuitFailure(sessionId, tc.name, typeof result.content === "string" ? result.content : undefined, circuitArgsSig(tc.arguments));
  }
  return CONTINUE;
};
