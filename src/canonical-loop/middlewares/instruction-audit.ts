/**
 * Pre-final-answer instruction audit.
 *
 * At wrap-up (a turn with assistant text and no tool calls — the model's
 * final answer) this middleware audits the op against the user's recorded
 * run constraints in the per-op instruction ledger:
 *
 *   1. Unmet obligation — the user said "commit when done" but no git commit
 *      was observed this op, OR "read X before you answer" but no read/grep/glob
 *      ran this op → nudge once (reason "instruction-obligation-unmet").
 *   2. Defense-in-depth violation — a tool belonging to a capability class the
 *      user forbade was attempted this op. The pre-dispatch layer should have
 *      blocked it; if one leaked through, surface it once at wrap-up
 *      (reason "instruction-violation") instead of letting the final answer
 *      present the run as compliant.
 *
 * FAIL-OPEN: no ledger, or a ledger with no matching constraint, means
 * every path returns `continue`. An op without user constraints must never
 * be nudged or delayed by this middleware.
 *
 * Commit detection reuses `checkPostCommit` (agent-guards/post-commit.ts) —
 * the canonical git-commit-output matcher — against a scratch LoopState in
 * afterToolExecution, so the regex isn't duplicated here and the post-commit
 * middleware's own shared state (its nudge-pending flag is transient) is
 * never perturbed. Tool-name sets can't carry this signal: there is no
 * dedicated commit tool, only bash output.
 */
import { checkPostCommit, createLoopState } from "../../agent-guards/index.js";
import { hasCapability } from "../../tool-registry.js";
import { getOpLedger, opObligations } from "../instruction-ledger/index.js";
import { getMiddlewareState } from "./state.js";
import type { CanonicalMiddleware } from "./types.js";

export const INSTRUCTION_OBLIGATION_REASON = "instruction-obligation-unmet";
export const INSTRUCTION_VIOLATION_REASON = "instruction-violation";

/** Repo-consulting tools that satisfy a "read before you answer" obligation. */
const READ_TOOLS = ["read", "grep", "glob"] as const;

interface AuditState {
  /** A successful git commit was observed in this op's tool output. */
  commitSeen: boolean;
  /** Each audit fires at most once per op, independently of the others. */
  obligationFired: boolean;
  readFirstFired: boolean;
  violationFired: boolean;
}

const initAuditState = (): AuditState => ({
  commitSeen: false,
  obligationFired: false,
  readFirstFired: false,
  violationFired: false,
});

export const instructionAuditMiddleware: CanonicalMiddleware = {
  name: "instruction-audit",

  // Observe only — never nudges from this hook. Records whether a git commit
  // landed so the wrap-up audit can check the commit-when-done obligation.
  afterToolExecution(ctx) {
    const state = getMiddlewareState<AuditState>(
      ctx.op.id,
      "instruction-audit",
      initAuditState,
    );
    if (!state.commitSeen && ctx.toolResults.length > 0) {
      // Scratch state: checkPostCommit sets postCommitNudgePending when the
      // results carry git's commit-success signature. Detection only.
      const scratch = createLoopState();
      checkPostCommit(
        ctx.toolResults.map(tr => ({ name: tr.toolName, result: tr.content })),
        scratch,
      );
      if (scratch.postCommitNudgePending) state.commitSeen = true;
    }
    return { kind: "continue" };
  },

  afterModelCall(ctx) {
    // Only audit the final answer. A mixed reasoning+tool turn is still
    // working (it may be about to commit); an empty turn has nothing to audit.
    if (ctx.toolCalls.length > 0) return { kind: "continue" };
    if (ctx.assistantContent.trim().length === 0) return { kind: "continue" };

    // Fail-open: no ledger recorded for this op → no user constraints → pass.
    const ledger = getOpLedger(ctx.op.id);
    if (!ledger) return { kind: "continue" };

    const state = getMiddlewareState<AuditState>(
      ctx.op.id,
      "instruction-audit",
      initAuditState,
    );

    // 1. Commit-when-done obligation, unmet at wrap-up.
    const wantsCommit = opObligations(ctx.op.id)
      .some(o => o.kind === "commit-when-done");
    if (wantsCommit && !state.commitSeen && !state.obligationFired) {
      state.obligationFired = true;
      return {
        kind: "nudge",
        message:
          "(Instruction audit: the user asked you to COMMIT when done, but no " +
          "git commit has been observed this op. Commit your changes now " +
          "(git add + git commit), then wrap up. If there is genuinely nothing " +
          "to commit, state that explicitly in one sentence.)",
        reason: INSTRUCTION_OBLIGATION_REASON,
      };
    }

    // 1b. Read-before-answer obligation: the user asked to consult the repo
    // before answering, but this final answer arrived with no read/grep/glob
    // this op. Nudge once to open the file(s) first, then answer. (toolsCalledThisOp
    // is the ok-only set, so a failed read doesn't count as satisfying it.)
    const wantsReadFirst = opObligations(ctx.op.id).some(o => o.kind === "read-before-answer");
    if (wantsReadFirst && !state.readFirstFired &&
        !READ_TOOLS.some(t => ctx.toolsCalledThisOp.has(t))) {
      state.readFirstFired = true;
      return {
        kind: "nudge",
        message:
          "(Instruction audit: the user asked you to READ / consult the repo " +
          "before answering, but no read, grep, or glob has run this op. Open the " +
          "relevant file(s) first, then answer from what you actually read.)",
        reason: INSTRUCTION_OBLIGATION_REASON,
      };
    }

    // 2. Defense-in-depth: a forbidden capability class's tool was attempted
    // this op (attempted, not just succeeded — a blocked/errored try is still
    // a violation the final answer must not paper over).
    if (!state.violationFired && ledger.prohibitions.length > 0) {
      for (const tool of ctx.attemptedToolsThisOp) {
        const cls = ledger.prohibitions.find(c => hasCapability(tool, c));
        if (!cls) continue;
        state.violationFired = true;
        return {
          kind: "nudge",
          message:
            `(Instruction audit: the user forbade ${cls} for this run, but ` +
            `"${tool}" — a ${cls}-class tool — was attempted this op. ` +
            "Acknowledge this in your answer and do not present any result " +
            "that depends on it as compliant with the user's constraint.)",
          reason: INSTRUCTION_VIOLATION_REASON,
        };
      }
    }

    return { kind: "continue" };
  },
};
