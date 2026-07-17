// Delivery-point taint policy for the sandboxed-execute phase.
//
// THE INVARIANT: a session is tainted iff sensitive bytes actually entered the
// model context. Detection still runs on every sensitive-read result, but the
// taint RECORD is coupled to delivery: when the whole result is replaced by
// the redaction stub before the model sees it, the bytes provably never
// reached context — so the pending taint is dropped and the provisional
// pre-execute floor is withdrawn. Taint commits only on the paths where
// content is actually delivered (an errored result skips the stub, so its
// output — which can echo sensitive content — keeps the taint). Exfil of an
// on-disk secret the model never read is not taint's job on either branch:
// that is covered at send time by the egress guard's outbound scan and by the
// sandbox cage on the read itself.
//
// Previously the record fired on detection alone: a shell probe whose stdout
// held one real key tainted (and shell-bricked) the whole session even though
// the model only ever received the stub. Quarantining bytes the model never
// saw is not security — the invariant is what makes the block trustworthy.

import type { ToolResult } from "../types.js";
import {
  recordSensitiveRead,
  retractProvisionalTaint,
  isSensitivePath,
  extractSensitivePathsFromCommand,
  detectSecretsInOutput,
  redactSecretSpans,
} from "../data-lineage/index.js";
import type { TaintSource } from "../data-lineage/index.js";
import { recordExternalIngestion, isExternalIngestingTool } from "../data-lineage/external.js";
import { hasCapability } from "../tool-registry.js";
import { resolveAgentPath } from "../workspace/paths.js";
import { realpathDeep, isSanctionedWorkRootEnvFile } from "../security/layer/index.js";
import { createLogger } from "../logger.js";

const logger = createLogger("tool-execution");

// Sensitive-read tools whose taint is gated on the READ PATH (not on scanning
// returned content): a file read / pattern list. Their content scan is
// deliberately omitted to preserve canonical read/glob/grep behavior — output
// secret-scanning applies only to data-returning sensitive-read sinks.
const PATH_GATED_READS: ReadonlySet<string> = new Set(["read", "glob", "grep", "structural_search"]);

interface TaintPair {
  source: TaintSource;
  target: string;
}

export interface PreExecuteFloor {
  pairs: TaintPair[];
  preTaintedPath: string | null;
}

// Resolve a path arg the SAME way the file sinks do (project-root anchored,
// session-aware) BEFORE realpath, so a relative arg canonicalizes to the inode
// the tool actually opens — not a cwd-relative miss. realpathDeep follows every
// symlink segment (R4-19: `notes.txt → ~/.ssh/id_rsa` must resolve to the
// sensitive target); ENOENT falls back to the lexical string so a non-existent
// sensitive literal still gets its check.
function resolveTaintPath(rawPath: string, sessionId: string | undefined): string {
  try {
    return realpathDeep(resolveAgentPath(rawPath, sessionId));
  } catch {
    return rawPath;
  }
}

/**
 * Pre-execute taint FLOOR-set (R4-09 defense-in-depth).
 *
 * The egress gate (dataLineageGate) CHECKS the taint floor in the policy phase;
 * the sensitive-read taint WRITE happens after execute. Within one Promise.all
 * batch sharing a sessionId, a co-batched egress tool could therefore observe
 * an EMPTY floor. The batcher (executeToolCalls) already keeps egress and
 * sensitive-read tools in SEPARATE sequential batches — this is the second line
 * of defense: when the read is sensitive KNOWABLE FROM ARGS, set the floor
 * synchronously before execute. The entries are PROVISIONAL (content-less):
 * the post-execute policy either upgrades them with content fingerprints
 * (bytes delivered) or retracts them (result fully stubbed — nothing entered
 * context, delivery-point invariant).
 */
export function setPreExecuteTaintFloor(
  toolName: string,
  args: Record<string, unknown>,
  sessionId: string | undefined,
): PreExecuteFloor {
  const sid = sessionId || "default";
  const floor: PreExecuteFloor = { pairs: [], preTaintedPath: null };
  const isSensitiveReadCap = hasCapability(toolName, "sensitive-read");
  if (isSensitiveReadCap && toolName !== "bash" && typeof args.path === "string" && args.path) {
    const taintPath = resolveTaintPath(String(args.path), sessionId);
    // The sanctioned work-root env file skips the PATH-based pre-taint — the
    // post-execute check taints it CONTENT-conditionally instead, so a
    // placeholder-only .env.local never bricks the shell but a real key
    // pasted into it still gets the redaction stub.
    if (isSensitivePath(taintPath) && !isSanctionedWorkRootEnvFile(sessionId, taintPath)) {
      recordSensitiveRead(sid, "sensitive_file", taintPath);
      floor.pairs.push({ source: "sensitive_file", target: taintPath });
      floor.preTaintedPath = taintPath;
    }
  } else if (toolName === "bash") {
    for (const p of extractSensitivePathsFromCommand(String(args.command || ""))) {
      recordSensitiveRead(sid, "sensitive_file", p);
      floor.pairs.push({ source: "sensitive_file", target: p });
    }
  }
  return floor;
}

/**
 * Post-execute taint + redaction policy. Returns the result the model may see:
 * either the tool's own result (possibly with inbound secret spans redacted)
 * or the whole-result redaction stub.
 *
 * Detection is unchanged from the pre-invariant behavior; only the COMMIT is
 * moved: each branch stages a pending taint record, and the stub decision at
 * the end either drops them all + retracts the provisional floor (stub
 * delivered → no sensitive byte in context → no taint) or commits them
 * (content delivered → taint as before).
 */
export function applyResultTaintPolicy(
  toolName: string,
  args: Record<string, unknown>,
  sessionId: string | undefined,
  result: ToolResult | undefined,
  floor: PreExecuteFloor,
): ToolResult | undefined {
  const sid = sessionId || "default";
  let redactReason: string | null = null;
  const pending: Array<{ source: TaintSource; target: string; content?: string }> = [];
  const isSensitiveRead = hasCapability(toolName, "sensitive-read");

  // Path-carrying sensitive-read sinks (read, ari_file, glob, grep, …): a read
  // of a sensitive path redacts (and, if delivered, taints). Keyed on the
  // REALPATH of the arg, not the raw name (R4-19, see resolveTaintPath).
  if (isSensitiveRead && toolName !== "bash" && args.path) {
    const taintPath = resolveTaintPath(String(args.path), sessionId);
    // The sanctioned work-root env file is CONTENT-conditional: a structured
    // secret shape (real API key / JWT / PEM) in its bytes gets the full
    // treatment, but placeholder-only content — the missing-creds recovery
    // path — must not redact the session's own scaffold.
    const fileContent = typeof result?.content === "string" ? result.content : undefined;
    const sanctionedEnv = isSanctionedWorkRootEnvFile(sessionId, taintPath);
    const envHoldsRealSecret = sanctionedEnv && !!fileContent && detectSecretsInOutput(fileContent).structured;
    if (isSensitivePath(taintPath) && (!sanctionedEnv || envHoldsRealSecret)) {
      // Content-bearing UPGRADE of the pre-execute floor entry: fingerprints
      // let a later egress block name which tainted bytes are in the payload.
      // Content is fingerprinted (hashed), never stored as plaintext.
      // Idempotency: if the floor already holds this exact path and there is
      // no content to fingerprint, the duplicate adds nothing.
      if (!(floor.preTaintedPath === taintPath && !fileContent)) {
        pending.push({ source: "sensitive_file", target: taintPath, content: fileContent });
      }
      redactReason = `${toolName} of sensitive path ${taintPath}`;
    }
  }

  if (toolName === "bash") {
    const matches = extractSensitivePathsFromCommand(String(args.command || ""));
    if (matches.length > 0) {
      // The floor for these paths was set pre-execute; whether it stands is
      // decided by the stub branch below (stubbed → retracted, delivered →
      // kept). No content-bearing re-record — these reads carry no per-path
      // content to fingerprint.
      redactReason = `bash command referenced sensitive path(s): ${matches.join(", ")}`;
    }
    const stdout = typeof result?.content === "string" ? result.content : "";
    // Only a SUCCESSFUL command's output is data the agent actually read; a
    // FAILED command's output is a diagnostic/error message. A benign
    // nonzero-exit bash whose stderr carried a coincidental token must not
    // trip the scanner.
    if (stdout.length > 0 && result && !result.isError) {
      const det = detectSecretsInOutput(stdout);
      // Redact only on a STRUCTURED credential — a real API-key/PEM/JWT shape
      // that genuinely surfaced a secret to stdout. A high-entropy-ONLY match
      // fires on long camelCase identifiers and hashes in ordinary source;
      // real exfil of such a token is still caught at send time by the egress
      // guard AND the threat tool-chain's outbound scan (both key on `matched`).
      if (det.structured) {
        pending.push({ source: "secret", target: `bash:${det.kinds.join(",")}`, content: stdout });
        redactReason = `bash output contained secret-shaped content (${det.kinds.join(", ")})`;
      } else if (det.matched) {
        logger.debug(
          `bash output had a high-entropy-only match (kinds: ${det.kinds.join(", ")}) — not redacting (coincidental identifier/hash in source; egress + tool-chain still scan any outbound send)`,
        );
      }
    }
  }

  // Owned-source DATA reads (sql_query, email_read, memory_search, ari_file
  // read, ari_retrieval, ari_database, ari_sqlite) return row/record content
  // from a LOCAL or account-owned source. A secret stored there is OUR secret,
  // so a hit gets the full owned-source treatment. Keyed on the sensitive-read
  // CLASS (excluding bash — handled above — and the path-listing
  // read/glob/grep, whose behavior is path-gated only).
  if (isSensitiveRead && !PATH_GATED_READS.has(toolName) && toolName !== "bash") {
    const body = typeof result?.content === "string" ? result.content : "";
    if (body.length > 0) {
      const det = detectSecretsInOutput(body);
      // Memory results routinely contain UUIDs, hashes, and tool-call ids from
      // old transcripts — an entropy-only hit there is not evidence of a
      // credential. Other owned sources keep the stricter historical behavior
      // because arbitrary high-entropy database/email values may be account
      // secrets.
      const shouldRedact = det.structured || (det.matched && toolName !== "memory_search");
      if (shouldRedact) {
        pending.push({ source: "secret", target: `${toolName}:${det.kinds.join(",")}`, content: body });
        redactReason = `${toolName} output contained secret-shaped content (${det.kinds.join(", ")})`;
      } else if (det.matched) {
        logger.debug(
          `${toolName} output had a high-entropy-only match (kinds: ${det.kinds.join(", ")}) — not redacting (common transcript id/hash false positive)`,
        );
      }
    }
  }

  // web_fetch / http_request bodies are UNTRUSTED INBOUND content from the
  // public internet — NOT a secret this system owns. A secret-shaped span is
  // coincidental (a slug, a sample key in docs) or a prompt-injection payload.
  // Strip those spans from the model's view (so it can't echo/exfil them) but
  // KEEP the rest of the page and DON'T taint the session. Exfil of OUR
  // secrets is guarded by the owned-source branches above + the egress
  // allowlist — not by bytes arriving from a trade site.
  if (toolName === "http_request" || toolName === "web_fetch") {
    const body = typeof result?.content === "string" ? result.content : "";
    if (body.length > 0 && result && !result.isError) {
      const red = redactSecretSpans(body);
      if (red.matched) {
        result = { ...result, content: red.text };
        logger.warn(
          `${toolName} response had secret-shaped span(s) redacted inline (kinds: ${red.kinds.join(", ")}) — not tainting (untrusted inbound source)`,
        );
      }
    }
  }

  // External-content ingestion mark (memory-promotion gate, NOT egress taint).
  // TOOL-CLASS keyed (D8): a successful result from an off-box-ingesting tool
  // (web_fetch/http_request/browser/search/mcp_*) means the model is about to
  // SEE external content this turn — mark the session so the memory
  // auto-promotion paths refuse durable writes: an LLM paraphrase of injected
  // material erases the content markers checkMemoryTaint keys on (D6).
  // Deliberately NOT content-sniffing the wrapExternalContent boundary — that
  // missed unwrapped browser reads and self-tainted any session that merely
  // read a source file containing the boundary literal.
  if (result && !result.isError && isExternalIngestingTool(toolName)) {
    recordExternalIngestion(sid);
  }

  if (redactReason && result && !result.isError) {
    // Whole-result stub: the sensitive bytes never reach the model, so per the
    // delivery-point invariant NOTHING entered context and nothing is tainted.
    // Withdraw the provisional floor and drop the pending records. Not a
    // declassify — no seen bytes are being released, no audit owed. A secret
    // the model tries to send anyway (from some other channel) is still caught
    // by the outbound egress scan at send time.
    if (floor.pairs.length > 0) retractProvisionalTaint(sid, floor.pairs);
    logger.info(`sensitive read fully redacted before delivery — session NOT tainted (${redactReason})`);
    return {
      content:
        `[redacted by data-lineage gate — ${redactReason}. ` +
        `The raw bytes were withheld from the model context, so nothing sensitive entered this session and no tools are blocked. ` +
        `Do not re-read this source; if a credential is needed, use a {{SECRET_NAME}} placeholder or ask the user.]`,
      isError: false,
      status: "blocked",
      metadata: { layer: "data-lineage", redacted: true, reason: redactReason },
    };
  }

  // No stub — whatever the tool returned (including an errored result's
  // output, which can echo sensitive content) is delivered. Commit the taint.
  if (pending.length > 0) {
    for (const p of pending) recordSensitiveRead(sid, p.source, p.target, p.content);
    logger.warn(
      `${toolName} result delivered without the redaction stub — session tainted for egress (${pending.map(p => p.target.slice(0, 60)).join(", ")})`,
    );
  }
  return result;
}
