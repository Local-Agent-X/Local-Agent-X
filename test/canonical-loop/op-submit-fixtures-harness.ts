/**
 * Old-path compatibility harness (Issue 10).
 *
 * Replays `op_submit_async`'s submit-time branch deterministically without
 * spinning up the legacy worker pool. The test asserts the externally-
 * observable contract — response template + post-submit disk layout — under
 * both flag values.
 *
 * Why a harness instead of calling the tool directly: `op_submit_async`'s
 * legacy branch invokes `void submitOp(op).catch(...)`, which fires the
 * worker pool subprocess machinery. Tests that bypass that produce a
 * stable, time-bounded snapshot. The harness's response template is
 * matched against `src/ops/tools.ts` source via a guard test, so
 * any drift in the actual tool's format string fails the suite.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Op, OpLane } from "../../src/ops/types.js";
import { writeOp, newOpId } from "../../src/ops/op-store.js";
import {
  canonicalLoopEntry,
  decideSubmitRouting,
  canonicalEventsPath,
  opTurnsDir,
  opMessagesPath,
  readCanonicalEvents,
  type CanonicalEvent,
} from "../../src/canonical-loop/index.js";
import { opDir } from "../../src/ops/event-log.js";

export interface HarnessSubmitArgs {
  task: string;
  type?: string;
  lane?: OpLane;
  ownerId?: string;
}

export interface HarnessSubmitResponse {
  /** Tool's content string; matches op_submit_async's template literal exactly. */
  content: string;
  /** Tool's isError flag — `false` (key absent) for the success branch. */
  isError: false;
}

export interface HarnessArtifacts {
  /** `~/.lax/operations/<id>/operation.json` exists and parses. */
  operationJsonPresent: boolean;
  /** Persisted op fields (loop-internal columns dropped — see PUBLIC_OP_FIELDS). */
  publicOp: Record<string, unknown>;
  /** Canonical sub-object on the persisted op (or null if absent / empty). */
  opCanonical: { flagValue: boolean | null; state: string | null } | null;
  /** `<opdir>/canonical-events.jsonl` exists. */
  canonicalEventsExists: boolean;
  /** Canonical event types in seq order (empty if file missing). */
  canonicalEventTypes: string[];
  /** `<opdir>/op-turns/` directory exists. */
  opTurnsDirExists: boolean;
  /** `<opdir>/op-messages.jsonl` exists. */
  opMessagesExists: boolean;
  /** Legacy event log `<opdir>/events.jsonl` exists. */
  legacyEventsExists: boolean;
}

export interface HarnessSubmitResult {
  opId: string;
  /** "canonical" when the flag was ON for the op's lane; "legacy" otherwise. */
  route: "canonical" | "legacy";
  /** flagValue captured at submit (PRD §17). */
  flagValue: boolean;
  /** The exact content/isError envelope the tool returns to the caller. */
  response: HarnessSubmitResponse;
  /** Post-submit disk snapshot. */
  artifacts: HarnessArtifacts;
}

/**
 * Subset of `Op` fields that the public callers (chat agent, MCP, sidebar)
 * read. Loop-internal columns (`canonical`, `workerId`, `lastFailureAt`, ...)
 * are intentionally excluded so a fixture diff catches public-shape drift
 * without churning on internal-only changes.
 */
const PUBLIC_OP_FIELDS = [
  "id",
  "type",
  "task",
  "lane",
  "ownerId",
  "visibility",
  "status",
  "attemptCount",
] as const;

/**
 * Drive op_submit_async's submit-time branch under the current flag value.
 *
 * Shape:
 *   1. Build an Op with stable test fields (no clocks bled in beyond
 *      `createdAt`, which is captured but normalized in the fixture).
 *   2. Run `decideSubmitRouting(op)` — same call op_submit_async uses.
 *   3. Canonical: invoke `canonicalLoopEntry(op)` (real loop entry).
 *      Legacy: invoke `writeOp(op)` directly. We bypass `submitOp` so
 *      worker subprocesses don't fire — the harness asserts the public
 *      submit-time contract, not worker execution.
 *   4. Format the response string with the SAME template
 *      `op_submit_async` uses (asserted via a source-drift guard test).
 *   5. Snapshot post-submit artifacts.
 */
export function harnessSubmit(args: HarnessSubmitArgs): HarnessSubmitResult {
  const op: Op = {
    id: newOpId("compat"),
    type: args.type ?? "freeform",
    task: args.task,
    contextPack: {} as Op["contextPack"],
    lane: args.lane ?? "interactive",
    retryPolicy: { maxRecoveryAttempts: 3, backoffMs: [5_000] },
    ownerId: args.ownerId ?? "compat-test",
    visibility: "private",
    status: "pending",
    createdAt: new Date().toISOString(),
    attemptCount: 0,
  };

  const routing = decideSubmitRouting(op);
  if (routing.route === "canonical") {
    canonicalLoopEntry(op);
  } else {
    writeOp(op);
  }

  return {
    opId: op.id,
    route: routing.route,
    flagValue: routing.flagValue,
    response: { content: formatSubmitResponse(op), isError: false },
    artifacts: snapshotArtifacts(op.id),
  };
}

/**
 * Mirror of `op_submit_async`'s tool response template. KEEP IN SYNC with
 * `src/ops/tools.ts`; the source-drift guard test (see
 * `canonical-loop-10-old-path-compat.test.ts`) asserts the literal
 * fragments of this template appear verbatim in the tool source.
 */
export function formatSubmitResponse(op: Pick<Op, "id" | "type" | "lane">): string {
  return (
    `op ${op.id} submitted (type=${op.type}, lane=${op.lane}).\n` +
    `Running in background — you can keep responding to the user. ` +
    `The user will see a notification when it completes.\n` +
    `Inspect anytime: op_status(op_id="${op.id}")  |  block on it: op_wait(op_id="${op.id}")`
  );
}

/**
 * Distinct fragments from the tool's response template that MUST exist
 * verbatim in `src/ops/tools.ts`. The drift guard scans the tool
 * source for each — any wording change requires a fixture refresh.
 */
export const RESPONSE_TEMPLATE_FRAGMENTS: readonly string[] = [
  "op ${op.id} submitted (type=${op.type}, lane=${op.lane})",
  "Running in background — you can keep responding to the user.",
  "The user will see a notification when it completes.",
  'Inspect anytime: op_status(op_id="${op.id}")',
  'block on it: op_wait(op_id="${op.id}")',
] as const;

// ── Snapshot helpers ─────────────────────────────────────────────────────

function snapshotArtifacts(opId: string): HarnessArtifacts {
  const opJsonPath = join(opDir(opId), "operation.json");
  const operationJsonPresent = existsSync(opJsonPath);
  let publicOp: Record<string, unknown> = {};
  let opCanonical: HarnessArtifacts["opCanonical"] = null;
  if (operationJsonPresent) {
    try {
      const raw = JSON.parse(readFileSync(opJsonPath, "utf-8")) as Record<string, unknown>;
      publicOp = pickPublicFields(raw);
      const c = raw.canonical as Record<string, unknown> | undefined;
      if (c && Object.keys(c).length > 0) {
        opCanonical = {
          flagValue: typeof c.flagValue === "boolean" ? c.flagValue : null,
          state: typeof c.state === "string" ? c.state : null,
        };
      }
    } catch { /* ignore — let the test catch it via operationJsonPresent */ }
  }
  const canonicalEventsExists = existsSync(canonicalEventsPath(opId));
  const canonicalEventTypes = canonicalEventsExists
    ? readCanonicalEvents(opId).map((e: CanonicalEvent) => e.type)
    : [];
  const opTurnsDirExists = existsSync(opTurnsDir(opId));
  const opMessagesExists = existsSync(opMessagesPath(opId));
  const legacyEventsExists = existsSync(join(opDir(opId), "events.jsonl"));
  return {
    operationJsonPresent,
    publicOp,
    opCanonical,
    canonicalEventsExists,
    canonicalEventTypes,
    opTurnsDirExists,
    opMessagesExists,
    legacyEventsExists,
  };
}

function pickPublicFields(raw: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const k of PUBLIC_OP_FIELDS) {
    if (k in raw) out[k] = raw[k];
  }
  return out;
}

// ── Fixture normalization (timestamps + ids) ─────────────────────────────

const ISO_TS = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d+Z/g;

/** Replace runtime-variable substrings with placeholders for fixture diff. */
export function normalizeForFixture(s: string, opId: string): string {
  return s.replaceAll(opId, "<OPID>").replace(ISO_TS, "<ISO_TS>");
}

export function normalizeArtifactsForFixture(art: HarnessArtifacts, opId: string): HarnessArtifacts {
  const op = { ...art.publicOp };
  if (typeof op.id === "string") op.id = "<OPID>";
  if (typeof op.createdAt === "string") op.createdAt = "<ISO_TS>";
  return { ...art, publicOp: op };
}
