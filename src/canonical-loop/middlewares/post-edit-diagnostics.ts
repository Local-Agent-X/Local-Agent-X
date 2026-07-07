/**
 * Post-edit diagnostics — when a turn's tool execution edits TS/JS source,
 * diff language-intel diagnostics against the op's per-file baseline and
 * inject ONLY the NEW errors as same-turn feedback, so the model sees "your
 * edit introduced these type errors" immediately instead of at build time.
 * Zero noise on files that were already red.
 *
 * Baseline strategy (deliberate, honest tradeoff): language-intel reads from
 * DISK with mtime staleness, and the edit is already flushed to disk by the
 * time afterToolExecution fires — so a true PRE-edit snapshot is impossible
 * for the first edit of a file in an op. The rule: the FIRST post-edit fire
 * for a file records its diagnostics as the baseline and reports NOTHING
 * (pre-existing red stays silent; a first-edit-introduced error is missed —
 * accepted, the build gate still catches it). Subsequent fires report only
 * diagnostics NOT in the baseline, matched by code + message (line/col shift
 * with every edit, so they are deliberately not part of the identity). The
 * baseline is immutable for the op: an introduced-and-still-unfixed error
 * re-reports on each later edit of that file — each turn's new errors matter.
 * A clean post-edit result is silence, not praise.
 *
 * All lanes — no `when` predicate, mirroring verify-gate's reasoning: coding
 * tasks arrive most often as interactive chat, and an edit that breaks the
 * type-check is equally wrong there.
 *
 * Fail-open everywhere: any language-intel fault logs a warning and the turn
 * proceeds untouched. This middleware must NEVER block or fail a turn.
 * Disable with LAX_POST_EDIT_DIAGNOSTICS=0.
 */
import type { CanonicalLoopContext, CanonicalMiddleware } from "./types.js";
import { getMiddlewareState } from "./state.js";
import { isDispatchFailure } from "../types.js";
import { EDIT_TOOLS } from "../../agent-guards/verify-gate.js";
import { getLanguageIntel, type FileDiagnostic } from "../../language-intel/index.js";
import { resolveAgentPath } from "../../workspace/paths.js";
import { createLogger } from "../../logger.js";

const logger = createLogger("canonical-loop.post-edit-diagnostics");

/** Cap on diagnostics shown in one injection — enough to act on, not a dump. */
const MAX_REPORTED = 10;

/** Cap on baseline-tracked files per op. Far above any real op's distinct-file
 *  count (same backstop posture as verify-gate's MAX_EDITED_PATHS); a file past
 *  the cap simply never reports, which is the fail-open direction. */
const MAX_TRACKED_FILES = 200;

interface PostEditDiagState {
  /** Resolved file path → diagnostic keys captured on the file's FIRST
   *  post-edit fire this op. Cleared with the rest of the per-op middleware
   *  state on op-terminal (clearMiddlewareStateForOp). */
  baselines: Map<string, Set<string>>;
  /** Resolved file path → INTRODUCED (non-baseline) errors present at the
   *  file's most recent check. Set/cleared on every post-baseline fire for
   *  the file, so it always reflects the last look the language service got.
   *  Known staleness: a file fixed INDIRECTLY (by editing a different file)
   *  isn't rechecked until it is edited again, so its entry can linger; the
   *  consumers tolerate that — a real clean verify outranks this state in
   *  checkVerifyGate, and the build-verify fail-fast is retry-bounded. */
  outstanding: Map<string, FileDiagnostic[]>;
  /** Resolved file path → TOTAL error count (baseline errors included) at the
   *  file's most recent check. Feeds opEditedFilesLspClean: pre-existing red
   *  honestly defeats "clean" even though it's never re-reported as new. */
  lastErrorCounts: Map<string, number>;
}

function createPostEditDiagState(): PostEditDiagState {
  return { baselines: new Map(), outstanding: new Map(), lastErrorCounts: new Map() };
}

// ── Read-only queries over the per-op state (no duplication elsewhere) ──────
// Timing contract for consumers: this state is written ONLY by this module's
// afterToolExecution hook (registry order 245). The readers run at done-claim
// time — verify-gate's afterModelCall wrap-up check (a turn with ZERO tool
// calls, so no afterToolExecution fires that turn) and the orchestrator
// build-verify gate (between turns) — so every read observes state written by
// a PRIOR turn's dispatch; there is no same-turn read/write race.

/** All introduced-and-still-unresolved errors across the op's edited files,
 *  per each file's most recent language-service check. */
export function opOutstandingIntroducedErrors(opId: string): FileDiagnostic[] {
  const state = getMiddlewareState<PostEditDiagState>(
    opId, "post-edit-diagnostics", createPostEditDiagState,
  );
  return [...state.outstanding.values()].flat();
}

/** True when the op has introduced type errors it has not resolved. */
export function opHasOutstandingIntroducedErrors(opId: string): boolean {
  return opOutstandingIntroducedErrors(opId).length > 0;
}

/** True when every edited-and-checked TS/JS file was fully error-free
 *  (pre-existing errors included) at its most recent check. False when the op
 *  never had a file diagnosed — absence of evidence is not clean. WEAK
 *  positive evidence by design (see "lsp-clean" in claim-grounding.ts). */
export function opEditedFilesLspClean(opId: string): boolean {
  const state = getMiddlewareState<PostEditDiagState>(
    opId, "post-edit-diagnostics", createPostEditDiagState,
  );
  if (state.lastErrorCounts.size === 0) return false;
  for (const count of state.lastErrorCounts.values()) {
    if (count > 0) return false;
  }
  return true;
}

/** Identity of a diagnostic for baseline matching: code + whitespace-normalized
 *  message. File is the map key above; line/col are deliberately excluded —
 *  they shift with every edit. */
function diagKey(d: FileDiagnostic): string {
  return `${d.code}::${d.message.replace(/\s+/g, " ").trim()}`;
}

/** Resolved paths of files touched by SUCCESSFUL edit-family calls this turn,
 *  filtered to languages language-intel supports. Same normalization as
 *  verify-gate's buildActions: tool name in EDIT_TOOLS, file from args
 *  file_path|path, dispatch status from the toolCallId-matched result (a
 *  failed or cancelled edit changed nothing worth diagnosing). */
function editedSupportedFiles(ctx: CanonicalLoopContext): string[] {
  const statusById = new Map(ctx.toolResults.map((tr) => [tr.toolCallId, tr.status]));
  const intel = getLanguageIntel();
  const out: string[] = [];
  for (const tc of ctx.toolCalls) {
    if (!EDIT_TOOLS.has(tc.tool)) continue;
    const status = statusById.get(tc.toolCallId);
    if (isDispatchFailure(status) || status === "cancelled") continue;
    const args = (tc.args ?? {}) as Record<string, unknown>;
    const raw =
      typeof args.file_path === "string" ? args.file_path
      : typeof args.path === "string" ? args.path
      : undefined;
    if (!raw) continue;
    const resolved = resolveAgentPath(raw);
    if (!intel.supports(resolved)) continue;
    if (!out.includes(resolved)) out.push(resolved);
  }
  return out;
}

function formatInjection(fresh: FileDiagnostic[]): string {
  const shown = fresh.slice(0, MAX_REPORTED);
  const lines = shown.map((d) => `${d.file}:${d.line}:${d.column} — TS${d.code}: ${d.message}`);
  const overflow =
    fresh.length > MAX_REPORTED ? `\n(+${fresh.length - MAX_REPORTED} more not shown)` : "";
  return (
    "Your edits this turn introduced NEW compile/type errors that were not present before them — " +
    "fix these before proceeding:\n" +
    lines.join("\n") +
    overflow
  );
}

export const postEditDiagnosticsMiddleware: CanonicalMiddleware = {
  name: "post-edit-diagnostics",

  // afterToolExecution: the edits are on disk, and a nudge from this hook is
  // the same injection channel post-commit uses — a user op_message the model
  // sees on its next step. Fires at most once per turn (one hook invocation);
  // no per-op cap, each turn's new errors matter.
  async afterToolExecution(ctx) {
    if (process.env.LAX_POST_EDIT_DIAGNOSTICS === "0") return { kind: "continue" };
    try {
      const files = editedSupportedFiles(ctx);
      if (files.length === 0) return { kind: "continue" };

      const state = getMiddlewareState<PostEditDiagState>(
        ctx.op.id,
        "post-edit-diagnostics",
        createPostEditDiagState,
      );

      const all = await getLanguageIntel().getDiagnostics(files);
      const errorsByFile = new Map<string, FileDiagnostic[]>();
      for (const d of all) {
        if (d.severity !== "error") continue;
        const bucket = errorsByFile.get(d.file);
        if (bucket) bucket.push(d);
        else errorsByFile.set(d.file, [d]);
      }

      const fresh: FileDiagnostic[] = [];
      for (const file of files) {
        const errors = errorsByFile.get(file) ?? [];
        const baseline = state.baselines.get(file);
        if (baseline === undefined) {
          // First post-edit sighting this op: capture baseline, report nothing
          // (see module docstring for why a true pre-edit state is unknowable).
          if (state.baselines.size < MAX_TRACKED_FILES) {
            state.baselines.set(file, new Set(errors.map(diagKey)));
            state.lastErrorCounts.set(file, errors.length);
          }
          continue;
        }
        const freshForFile = errors.filter((d) => !baseline.has(diagKey(d)));
        // Refresh the read-only-query maps: this check is now the file's most
        // recent language-service verdict (total red count + introduced set).
        state.lastErrorCounts.set(file, errors.length);
        if (freshForFile.length > 0) state.outstanding.set(file, freshForFile);
        else state.outstanding.delete(file);
        fresh.push(...freshForFile);
      }

      if (fresh.length === 0) return { kind: "continue" };
      return {
        kind: "nudge",
        reason: "post-edit-diagnostics",
        message: formatInjection(fresh),
      };
    } catch (err) {
      // Fail-open: diagnostics are advisory; a language-intel fault must never
      // block the turn.
      logger.warn(
        `fail-open: diagnostics diff failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      return { kind: "continue" };
    }
  },
};
