// Active failure-correction layer. When tools in a turn return non-ok
// statuses, the model often emits a confident "done!" message because it
// either didn't process the tool_result properly or wants to escape the
// loop. We inject a synthetic user-role nudge into turn+1 and force the
// drive loop to continue (override terminalReason "done" → null) so the
// model has to address the failure on the next turn instead of gaslighting
// the user. Real failure (2026-05-23): grok-code-fast-1 said "fixed it"
// while two `edit` calls hit `old_string found 2 times` and never wrote
// a byte.
//
// Why not a UI banner: the banner sits in the assistant message AFTER the
// turn — it tells the user but does nothing to fix the model's behavior.
// The nudge forces the model to either retry the failed call with the
// recovery hint it was given, or honestly admit it can't.
//
// LOOP SAFETY — DO NOT repeat the claim this header used to make ("the per-op
// turn cap in worker.ts terminates the drive loop regardless"). Measured
// 2026-08-26, it is false on every lane but one:
//   - worker.ts's `count >= maxTurns` branch is a CHECKPOINT CADENCE, not a
//     cap, whenever `op.lane !== "interactive"`: it emits
//     iteration_checkpoint{continuing:true} and resets `count = 0`.
//   - the wall-clock deadline is armed only `if (op.lane === "interactive" &&
//     …)`. Autonomous lanes get no deadline at all.
//   - contextPack budget.maxTokens defaults to 0 = OFF (ops/context-pack-
//     builder.ts) and no production path stamps one; chat-runner/create-op.ts
//     and ops/tools/shared.ts stamp only maxIterations / maxWallTimeMs.
// Nudges are still bounded (a nudge does not defer termination — the
// continuation guard in decide-outcome.ts re-opens exactly one turn and the
// model's own end_turn ends it). Anything here that DEFERS termination is not,
// and must carry its own bound: see MAX_BOOKKEEPING_DEFERRALS below.
//
// CALIBRATION — read the bound below as a correctness guard for adapters we do
// not control, NOT as an incident response. Measured 2026-08-26 across all
// 3,536 persisted turns of all 326 ops in ~/.lax/operations:
//   - resolveTerminatingMutation can only change an OUTCOME when the provider
//     reported NO stop reason. decide-outcome computes `mutationTerminates =
//     mutationCommitted && !modelWantsToContinue`, and adapters/model-stop.ts
//     maps everything except end_turn / stop / stop_sequence to "continue" — so
//     a reported tool_use suppresses this path entirely, and a reported end_turn
//     already terminates via modelSignaledDone. Only `modelStop === undefined`
//     reaches it.
//   - turns whose persisted stopReason is missing: anthropic 11 of 747,
//     openai-compat 8 of 2379, codex 4 of 394, plus 11 recorded under
//     adapterName lost-registration / runtime-reconstruction-failed. Turns with
//     tool calls AND no stop reason: ZERO.
//   - so neither the bug this bound contains nor the bound itself has ever
//     fired on this machine. The live path is an adapter that omits
//     finish_reason: app-build-adapter.ts persists a stopReason string but
//     returns no `modelStop` at all (so the count above flatters it — its 5
//     turns are all tool-less, and the ZERO stands), codex dropped the stop
//     event on 4 of 394 turns, and an OSS OpenAI-compatible server may omit it
//     on every turn.

import type { CommitTurnMessage } from "../checkpoint.js";
import { parseStatusHeader } from "../../tools/result-helpers.js";
import { extractToolResultText } from "./content-extract.js";
import { isMutationTool } from "../../tool-mutation-check.js";
import { isLedgerTool } from "../../committing-tool-check.js";
import { MEMORY_WRITE_TOOLS } from "./silent-tool-check.js";
import { getMiddlewareState } from "../middlewares/state.js";

type ToolSummaryEntry = { tool: string; toolCallId?: string };

export interface ToolFailureSummary {
  /**
   * `declined: true` marks a user-declined approval (status "declined") —
   * still a failure (the call didn't run, the model must not claim done),
   * but the nudge wording differs: a human said no to that specific call,
   * so "retry with the recovery hint" is exactly the wrong instruction.
   */
  failures: { tool: string; reason: string; declined?: boolean }[];
  /**
   * QUESTION A — "were this turn's failures followed by a real change, so a
   * 'done' claim is iteration rather than gaslighting?"
   *
   * True when at least one mutation tool (write / edit / build_app / browser
   * action / http_request / etc — see isMutationTool) succeeded in this
   * turn. Means the model actually changed something on disk or in the
   * outside world. Used to suppress the gaslighting nudge in the mixed
   * case where the model had failures earlier but ultimately landed a real
   * change — that's not gaslighting, that's iteration. Real failure 2026-
   * 05-23: one turn had 4 edit failures + 1 successful write
   * (the actual fix). My v1 nudge fired on the failures alone and forced
   * an extra turn that regurgitated the same response, surfacing as a
   * "chat printed response twice" UX bug.
   *
   * Read by shouldNudgeForFailures and NOTHING else. Deliberately broad: a
   * false positive here only SUPPRESSES a nudge (harmless), while a false
   * negative fires the redundant extra turn described above. Do NOT reuse it
   * for termination — see hadTerminatingMutation, where the same asymmetry
   * runs the other way.
   */
  hadSuccessfulMutation: boolean;
  /**
   * QUESTION B — "did this turn commit work the model would only re-narrate,
   * so the TURN CAN END here without a wrap-up?"
   *
   * hadSuccessfulMutation MINUS the agent's own BOOKKEEPING. Read only through
   * resolveTerminatingMutation (below) by decide-outcome.ts's
   * `mutationTerminates`. A separate field because the direction of failure
   * inverts: a false positive here ENDS THE OP EARLY and strands the work,
   * while a false negative only costs one wrap-up turn.
   *
   * "Only costs one turn" is true per turn and FALSE per op unless the
   * deferral is bounded — see resolveTerminatingMutation. Never read this
   * field directly from the decision site.
   *
   * Two carve-outs, both the destructive-direction mirror of
   * committing-tool-check.ts:opCommittedSubstantiveWork — "a gate that forces
   * another turn because steps are open must not accept the task_create calls
   * that OPENED those steps as the evidence that more work is owed":
   *
   *  1. THE TASK LEDGER. task_create is risk `workspace-write`
   *     (tool-policy/tool-policies.apps.ts) so isMutationTool answers true, and
   *     task_* is not silent (silent-tool-check.ts), so a plain planning turn —
   *     model writes its to-do list, narrates the plan, provider reports no stop
   *     reason — used to resolve `done` and transition the op to `succeeded`
   *     having done none of the work it just planned.
   *  2. MEMORY WRITES. Every name in MEMORY_WRITE_TOOLS is workspace-write or
   *     destructive, so isMutationTool answers true for all of them. (The
   *     converse does NOT hold — seven memory_* mutation tools are missing from
   *     that list; see the KNOWN GAP test in test/tool-failure-summary.test.ts.)
   *     A turn that pairs `memory_save` with a DATA-RETURNING call (bash, read,
   *     web_fetch) then terminated on the memory write and stranded the result
   *     the model had not yet surfaced. A memory-ONLY turn is unaffected — but
   *     NOT because `silentTerminates` ends it, which is what this comment used
   *     to claim and is REFUTED: silentTerminates and mutationTerminates both
   *     sit inside decide-outcome's single `assistantText.trim().length > 0`
   *     gate, so they move together. A NARRATED memory-only turn terminates on
   *     silentTerminates whatever this field answers; a narration-less one
   *     terminates on NEITHER and had no terminal to lose. Production proof the
   *     cited net does not fire on its own: op_memory_consolidation_
   *     88904dfe172f4577 turns 60-159 are 100 consecutive narration-less
   *     memory-write turns (60 memory_update_profile, 61-159 `forget`), every
   *     one committed with `terminalReason: null`.
   *     The only shape this changes is the mixed one — exactly the stranded case.
   */
  hadTerminatingMutation: boolean;
}

/**
 * The agent's own bookkeeping — the task ledger plus memory writes. Neither
 * predicate is defined here: isLedgerTool is imported from the ONE definition
 * in committing-tool-check.ts (a leaf whose only imports are tool-registry.ts
 * and plugin-system/tool-metadata.ts — the same two ../../tool-mutation-check.js
 * above already pulls, so this adds zero transitive dependencies), and
 * MEMORY_WRITE_TOOLS from the sibling silent-tool-check.ts (type-only imports).
 * The previous local copy of `startsWith("task_")` was the third of three, and
 * three copies gating three different failure directions is this campaign's
 * root failure class.
 *
 * The prefix half is an unbounded match, NOT a registry lookup: an active
 * plugin tool named `task_*` bypasses the policy table and would be silently
 * excluded from termination. See the hazard note on isLedgerTool.
 */
function isBookkeepingTool(name: string): boolean {
  return isLedgerTool(name) || MEMORY_WRITE_TOOLS.has(name);
}

export function collectToolFailures(
  toolMessages: CommitTurnMessage[],
  toolSummary: ToolSummaryEntry[],
): ToolFailureSummary {
  const failures: ToolFailureSummary["failures"] = [];
  let hadSuccessfulMutation = false;
  let hadTerminatingMutation = false;
  for (let i = 0; i < toolMessages.length; i++) {
    const text = extractToolResultText(toolMessages[i].content);
    const status = parseStatusHeader(text);
    // HAZARD (pre-existing, cost raised here). This pairs toolMessages[i] with
    // toolSummary[i] BY INDEX even though both rows carry a `toolCallId` that
    // would pair them exactly. Any path that filters, reorders, or drops from
    // one list and not the other silently mislabels every row after the skew.
    // Until this chunk the only consequence was a wrong tool NAME in a nudge
    // and possibly one redundant turn. `hadTerminatingMutation` now feeds
    // TERMINATION, so a skew that lands a mutation name on a read row ends the
    // op early, and one that lands a read name on a mutation row leaves it
    // running. Fixing it means matching on toolCallId with an explicit
    // fallback for the legacy rows that carry none — deliberately NOT done in
    // this chunk (it changes pairing for every existing consumer), but it is
    // no longer a cosmetic bug.
    const toolName = toolSummary[i]?.tool ?? "unknown";
    if (status === "ok") {
      // Two questions, two flags — see the interface docs. Never collapse
      // these back into one: A may over-count safely, B may not.
      if (isMutationTool(toolName)) {
        hadSuccessfulMutation = true;
        if (!isBookkeepingTool(toolName)) hadTerminatingMutation = true;
      }
      continue;
    }
    if (status === "running") continue;
    // Strip the rendered status header + collapse multi-line content so the
    // nudge stays short; full failure is still in the tool_result row.
    const firstLine = text.replace(/^\[[^\]]*\]\n?/, "").split("\n")[0].slice(0, 200);
    failures.push(status === "declined"
      ? { tool: toolName, reason: firstLine, declined: true }
      : { tool: toolName, reason: firstLine });
  }
  return { failures, hadSuccessfulMutation, hadTerminatingMutation };
}

/**
 * How many CONSECUTIVE bookkeeping-only turns an op may defer termination for
 * before the deferral is spent and question B falls back to question A —
 * i.e. the op terminates exactly as it did before this carve-out existed.
 *
 * WHY A BOUND EXISTS AT ALL. Deferring termination is only safe if something
 * downstream eventually stops the op. Nothing reliably does (see the LOOP
 * SAFETY block at the top of this file), and the same task_create that
 * triggers the deferral also disarms every remaining brake: it is a committing
 * tool, so mid-turn-stale's second-strike abort is permanently suppressed for
 * the rest of the op; it is a mutation tool AND a progress tool read from the
 * CALL not the result, so the no-progress and discovery-loop counters reset
 * every turn even when it FAILS. On an autonomous lane that leaves only
 * repeat-output (Jaccard >= 0.9), which varied plan wording escapes.
 *
 * WHY 3.
 *  - 1 breaks the ordinary opening pair: task_create (open the plan), then
 *    task_update (mark step 1 in_progress), before a byte is written.
 *  - 2 covers that pair with no slack for a mid-course re-plan after a failure.
 *  - 3 covers plan -> mark -> re-plan, the longest bookkeeping-only run with a
 *    legitimate reading, and caps the added exposure at 3 turns per real commit
 *    where the pre-C9 code had 0 and the unbounded C9 code had 120-300
 *    (interactive) or no limit at all (autonomous).
 *  - >3 is MEASURED, not asserted, and the memory widening decalibrated the
 *    original reasoning by ~30x. Replay of all 326 persisted ops / 3,536 turns
 *    (~/.lax/operations, 2026-08-26), longest CONSECUTIVE bookkeeping-only run
 *    per op:
 *      ledger-only (the original C9 scope): {0:305, 1:8, 2:7, 3:6} — ZERO ops
 *        exceed 3 and the maximum observed is exactly 3. "plan -> mark ->
 *        re-plan" is empirically the ceiling, not a guess.
 *      memory-inclusive (what this carve-out widened it to): {0:261, 1:29,
 *        2:11, 3:10, 4:2, 5:7, 6:1, 7:2, 60:1, 84:1, 92:1} — 15 of 326 ops
 *        (4.6%) exceed 3 and the longest real run is 92 turns.
 *    Every over-3 op is type=memory_consolidation, lane=background, and none of
 *    those turns can reach a terminal: they carry EMPTY assistantText, which
 *    decide-outcome gates the whole done-decision on. Of the 400
 *    bookkeeping-only turns in the corpus only 13 are narrated, and the longest
 *    consecutive run of narrated ones is 1. So 3 stays right for the path that
 *    actually reaches this decision — do not raise it off the 92.
 *    (The counter still ticks on narration-less turns: an op that ran 92 of
 *    them meets its next narrated bookkeeping turn with the budget already
 *    spent, i.e. the exact pre-C9 answer. Not a regression, but not a reset.)
 *  - "bookkeeping-only" is NOT "zero work in between". `bash` is risk `shell`,
 *    which tool-mutation-check.ts deliberately excludes from MUTATION_RISKS, so
 *    a `bash npm test` + `task_update` turn — a verify loop doing real work —
 *    classifies as bookkeeping-only here and burns a deferral.
 */
export const MAX_BOOKKEEPING_DEFERRALS = 3;

const BOOKKEEPING_DEFERRAL_STATE = "bookkeeping-only-deferrals";

/**
 * QUESTION B, BOUNDED. The only supported reader of hadTerminatingMutation.
 *
 * Returns "may this turn terminate on its committed mutation?" — the value
 * decide-outcome.ts feeds into `mutationTerminates`.
 *
 * The counter is PER-OP-PER-WORKER-PROCESS, not per-turn. It lives in the
 * middlewares/state.ts module-scoped `STATES` map keyed by opId (the same
 * registry the interactive empty-turn terminator uses), with NO serialization.
 * Per-op is the whole point — a per-turn flag would let plan / plan / plan
 * reset itself — and per-op survives a re-queue: the one production caller of
 * clearMiddlewareStateForOp is state-machine.ts:196, inside finalizeTerminalState,
 * which runs only for TERMINAL states, and `running -> queued` is not terminal.
 * So none of the re-queue paths (worker-adapter-retry.ts:19 and :66,
 * recovery.ts:265, control-api.ts:271) clear it.
 *
 * A dead worker PROCESS is the seam. ProcessExecutionBackend forks a child per
 * start (eligible: lane background/agent on an exact-delegated agent-runner
 * runtime), so a relaunch begins with an empty STATES map and a fresh budget.
 * Relaunching from `running` DOES consume op.attemptCount against
 * retryPolicy.maxRecoveryAttempts (ops/heartbeat.ts), so the real ceiling is
 * MAX_BOOKKEEPING_DEFERRALS x (1 + maxRecoveryAttempts): 12 at the table's
 * default of 3, 18 at its highest (research_query and memory_consolidation, 5),
 * 9 for autopilot_round (2). Bounded — just not by 3.
 *
 * The one genuinely unbounded requeue path is inert: recovery.ts:189-203
 * re-enqueues a `state === "queued"` op WITHOUT consuming a recovery attempt
 * (deliberately — no turn ran, so relaunch is idempotent), so an op crash-
 * looping inside the acquireLease -> running window re-enqueues forever. That
 * is pre-existing, runs zero turns, and is not model-drivable: it can never
 * produce a bookkeeping turn at all.
 *
 * Three cases, and the reset rule is what makes the bound hold:
 *   - real (non-bookkeeping) mutation landed -> terminate, and RESET. Actual
 *     work on the user's request refreshes the deferral budget. The model
 *     cannot manufacture this reset with more planning; it has to write to
 *     disk or the outside world.
 *   - no successful mutation at all (reads, failures, pure narration) ->
 *     do not terminate, and leave the counter ALONE. Deliberately neutral, so
 *     interleaving a read turn between plans cannot launder the count. Those
 *     turns already drive a wrap-up for their own reasons; they are not a
 *     deferral this carve-out caused.
 *   - bookkeeping-only -> increment; defer while at or under the cap, and once
 *     past it return the pre-carve-out answer (hadSuccessfulMutation) so the op
 *     ends. Never reset on the way out: if a completion gate re-opens that
 *     turn, the next bookkeeping-only turn must terminate immediately, not buy
 *     another 3.
 *
 * LANE-INDEPENDENT BY CONSTRUCTION. There is no `op.lane` test here and none
 * upstream on this path — decideTurnOutcome runs once per driveTurn on every
 * lane. That is precisely why the bound lives at the decision instead of in
 * worker.ts, which caps interactive ops only.
 *
 * KNOWN LIMIT, stated rather than papered over: this restores the PRE-C9
 * terminator, it does not add a new one. When the provider reports tool_use
 * (`modelWantsToContinue`), decide-outcome's `mutationTerminates` is false
 * regardless of what this returns — the P-1 fix, which exists so a multi-step
 * build does not end after every file write. An op whose provider reports
 * tool_use on every single turn was already unbounded before this carve-out
 * existed; that is a different bug and undoing P-1 is not its fix.
 */
export function resolveTerminatingMutation(opId: string, summary: ToolFailureSummary): boolean {
  const state = getMiddlewareState<{ deferrals: number }>(
    opId, BOOKKEEPING_DEFERRAL_STATE, () => ({ deferrals: 0 }),
  );
  if (summary.hadTerminatingMutation) {
    state.deferrals = 0;
    return true;
  }
  if (!summary.hadSuccessfulMutation) return false;
  state.deferrals += 1;
  return state.deferrals > MAX_BOOKKEEPING_DEFERRALS;
}

/** QUESTION A only. Reads hadSuccessfulMutation — never hadTerminatingMutation:
 *  a task_create that landed after a failed edit is still a real change, so the
 *  "you're gaslighting" nudge would be wrong. */
export function shouldNudgeForFailures(summary: ToolFailureSummary): boolean {
  // Nudge ONLY when there are failures AND no successful mutation. If the
  // model retried and eventually succeeded with a real change, accept its
  // "done" — that's progress, not gaslighting. Read-only successes (read,
  // grep, glob) don't count: a model can spam reads after edit failures
  // and then claim done; nudge still fires there because read isn't a
  // mutation tool.
  return summary.failures.length > 0 && !summary.hadSuccessfulMutation;
}

export function formatFailureNudgeForModel(summary: ToolFailureSummary): string {
  if (summary.failures.length === 0) return "";
  const n = summary.failures.length;
  const noun = n === 1 ? "call" : "calls";
  // When EVERY failure is a user decline, "retry with the recovery hints" is
  // exactly the wrong instruction — the header must not urge retrying.
  const allDeclined = summary.failures.every((f) => f.declined);
  const lines = [
    allDeclined
      ? `[automatic check] ${n} tool ${noun} in your last turn ${n === 1 ? "was" : "were"} declined by the user. Do NOT claim the task is done, and do NOT retry the declined ${noun} as-is — adjust your approach or ask the user what they'd prefer.`
      : `[automatic check] ${n} tool ${noun} in your last turn returned a non-ok status. Do NOT claim the task is done until you've either retried successfully (use the recovery hints already in the tool_result) or honestly reported what's still broken to the user.`,
    "",
    "Failed calls:",
  ];
  for (const f of summary.failures) {
    lines.push(f.declined ? `• ${f.tool} — declined by the user: ${f.reason}` : `• ${f.tool} — ${f.reason}`);
  }
  if (summary.failures.some((f) => f.declined)) {
    lines.push(
      "",
      "Note: a call marked \"declined by the user\" means the user said no to that specific action — the tool is NOT broken and this is not a policy block. Do not immediately repeat that call; adjust your approach or ask the user what they'd prefer. If the user then tells you to proceed, you may request approval again.",
    );
  }
  return lines.join("\n");
}
