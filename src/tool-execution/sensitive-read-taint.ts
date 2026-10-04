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
  sensitivePathsReadByCommand,
  detectSecretsInOutput,
  withholdSecretValues,
  secretsMaskedNote,
  isSecretEndpointUrl,
} from "../data-lineage/index.js";
import type { TaintSource, MaskOptions } from "../data-lineage/index.js";
import { recordExternalIngestion, isExternalIngestingTool } from "../data-lineage/external.js";
import { DEFAULT_MAX_RESULT_CHARS } from "../context-manager/tool-result-cap.js";
import { hasCapability } from "../tool-registry.js";
import { resolveAgentPath } from "../workspace/paths.js";
import { realpathDeep, isSanctionedWorkRootEnvFile } from "../security/layer/index.js";
import { recordPrivateReadFromResult } from "./private-read-record.js";
import { createLogger } from "../logger.js";
import { recordResponseTokens } from "../browser/site-provenance.js";
import { withMetadata } from "../tools/result-helpers.js";

const logger = createLogger("tool-execution");

// Sensitive-read tools whose taint is gated on the READ PATH (not on scanning
// returned content): a file read / pattern list. Their output is masked for
// registered values only (maskScope), preserving canonical read/glob/grep
// behavior on files that merely contain credential-shaped strings.
const PATH_GATED_READS: ReadonlySet<string> = new Set(["read", "glob", "grep", "structural_search"]);

/**
 * How much of a delivered output is masked.
 *  - web_fetch / http_request bodies: credential shapes, credential-named
 *    fields, registered values, and every value a secrets endpoint served. The
 *    tools mask before their `find` filter; this is the seam's own guarantee
 *    for a result that reached here another way.
 *  - shell output and owned-source records (sql_query, email_read,
 *    memory_search, ari_* reads): the same, without the endpoint rule. No
 *    channel masks on looks alone (secret-values.ts): exfil of a random-looking
 *    token is caught at send time.
 *  - every other tool (file reads, searches, documents, process output):
 *    registered values only. A credential shape in a source file is content
 *    the model is working on; the user's stored secrets and the operator token
 *    never are, whichever tool happens to carry them.
 */
function maskScope(toolName: string, args: Record<string, unknown>, isSensitiveRead: boolean): MaskOptions {
  if (toolName === "http_request" || toolName === "web_fetch") return { endpoint: isSecretEndpointUrl(args.url) };
  if (toolName === "bash" || (isSensitiveRead && !PATH_GATED_READS.has(toolName))) return {};
  return { knownOnly: true };
}

/**
 * Mask the secret VALUES in everything the model is shown of a result, in
 * place, and register each as a known secret (secret-values.ts): the model
 * keeps the listing, the rows, the rest of the file, and loses only the
 * values; the registry stops them leaving at every egress sink. Whole-result
 * withholding because one span matched cost the model a `supabase` listing
 * and an inbox it was asked to set up (2026-09-18). The session is NOT
 * tainted: the bytes never entered context.
 *
 * "Shown" is the content AND every string metadata field:
 * renderToolResultForModel prints partial_output, recovery and userHint in
 * full and every other string in its header. A shell timeout carries its
 * output only there (stderr, partial_output), and every shell error repeats
 * stderr in the header. Masking runs before the header's 60-char cut, which
 * would otherwise print a value's first 60 characters.
 */
export function maskDeliveredSecrets(toolName: string, args: Record<string, unknown>, result: ToolResult): ToolResult {
  const scope = maskScope(toolName, args, hasCapability(toolName, "sensitive-read"));
  let masked = 0;
  const kinds = new Set<string>();
  const mask = (text: string): string => {
    const m = withholdSecretValues(text, scope);
    masked += m.masked;
    for (const kind of m.kinds) kinds.add(kind);
    return m.text;
  };
  const content = typeof result.content === "string" ? mask(result.content) : result.content;
  const metadata = Object.fromEntries(
    Object.entries(result.metadata ?? {}).map(([key, value]) => [key, typeof value === "string" ? mask(value) : value]),
  );
  if (masked === 0) return result;
  const note = secretsMaskedNote(masked, [...kinds]);
  // A tool that masked its own body (http_request, web_fetch) already counted
  // those; this pass adds what it found beyond them.
  const prior = typeof metadata.secrets_masked === "number" ? metadata.secrets_masked : 0;
  return withMetadata({ ...result, content: content ? `${content}\n\n${note}` : note }, { ...metadata, secrets_masked: prior + masked });
}

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
    for (const p of sensitivePathsReadByCommand(String(args.command || ""))) {
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
    const matches = sensitivePathsReadByCommand(String(args.command || ""));
    if (matches.length > 0) {
      // The floor for these paths was set pre-execute; whether it stands is
      // decided by the stub branch below (stubbed → retracted, delivered →
      // kept). No content-bearing re-record — these reads carry no per-path
      // content to fingerprint. A command that names a secrets FILE gets the
      // whole-result stub; any other command's output is masked below.
      redactReason = `bash command referenced sensitive path(s): ${matches.join(", ")}`;
    }
  }

  // A result the stub below replaces is never delivered, so it is not masked.
  if (result && !(redactReason && !result.isError)) result = maskDeliveredSecrets(toolName, args, result);

  // What a network response showed the model, after masking, it may send back
  // to that site: an id an API returned is the next request's path, and the
  // outbound scan would otherwise refuse it as a random-looking token.
  if ((toolName === "http_request" || toolName === "web_fetch") && typeof result?.content === "string") {
    recordResponseTokens(sessionId ?? "", String(args.url ?? ""), result.content);
  }

  // External-content ingestion mark (memory-promotion gate, NOT egress taint).
  // TOOL-CLASS keyed (D8): a successful result from an off-box-ingesting tool
  // (web_fetch/http_request/browser/search/mcp_*) means the model is about to
  // SEE external content this turn — mark the session so the memory
  // auto-promotion paths can refuse a durable write that carries its bytes: an
  // LLM paraphrase of injected material erases the content markers
  // checkMemoryTaint keys on (D6). Deliberately NOT content-sniffing the
  // wrapExternalContent boundary — that missed unwrapped browser reads and
  // self-tainted any session that merely read a source file containing the
  // boundary literal. The bytes fingerprinted are what the model can see: the
  // audit phase's budgetResult caps every delivered result at
  // DEFAULT_MAX_RESULT_CHARS, so the head up to that ceiling is the whole
  // delivered content (the spilled tail is reachable only through a later
  // local `read`, which this tool-class axis does not cover).
  if (result && !result.isError && isExternalIngestingTool(toolName)) {
    const url = typeof args.url === "string" ? ` ${args.url}` : "";
    recordExternalIngestion(sid, result.content.slice(0, DEFAULT_MAX_RESULT_CHARS), `${toolName}${url}`);
  }
  // Private content (an email body, a personal document): recorded so a send
  // to someone new can be put to the user (private-content-gate.ts).
  recordPrivateReadFromResult(sid, toolName, args, result, DEFAULT_MAX_RESULT_CHARS);

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
        `This read did NOT complete: none of this source's content is available to you, so whatever you meant to check with it is unverified — report it as not checked, never as done. ` +
        `The raw bytes were withheld from the model context, so nothing sensitive entered this session and no tools are blocked. ` +
        `Do not re-read this source; if a credential is needed, use a {{SECRET_NAME}} placeholder or ask the user.]`,
      isError: false,
      status: "blocked",
      metadata: {
        layer: "data-lineage", redacted: true, reason: redactReason,
        recovery: "Do not re-read this source. Report what it was for as not checked, and continue with the rest of the request.",
      },
    };
  }

  // Policy denial (status:"blocked" per the 5-state envelope): the tool was
  // refused BEFORE producing data — no sensitive byte was read, let alone
  // delivered. Same invariant outcome as the stub: withdraw the provisional
  // floor and drop the pending records. (Only gate-authored denials use this
  // status; a mid-read failure is status:"error" and commits below.)
  if (result?.isError && result.status === "blocked") {
    if (floor.pairs.length > 0) retractProvisionalTaint(sid, floor.pairs);
    return result;
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
