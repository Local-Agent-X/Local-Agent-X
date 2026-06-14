/**
 * Mid-turn stall check. Canonical-loop port of
 * src/agent-loop/middlewares/mid-turn-stale.ts, with a second trigger.
 *
 * Two ways a worker spins after MIN_ITERATION turns with nothing committed:
 *
 *   Branch 1 — flat evidence: the per-turn evidence count (maintained across
 *   turns in ctx.evidenceHistory) is unchanged for STALE_WINDOW turns. Same
 *   tools, same args, same empty results. Two-strike: nudge, then abort.
 *
 *   Branch 2 — monotonous action: evidence is GROWING, but every turn in the
 *   window did nothing but call one non-committing external-action tool
 *   (browser) with no commit. This is the "looks busy, isn't progressing" spin
 *   — the agent clicks through a Google Calendar / consent / login page turn
 *   after turn, each click succeeds and counts as evidence, so Branch 1 never
 *   fires even though the goal isn't advancing. Nudge ONCE to force the agent
 *   to verify real progress or surface the blocker. No abort here: a browser
 *   filling a multi-field form looks identical to one stuck on a wall, and we
 *   can't tell them apart without goal-awareness — a nudge is curative for the
 *   stuck case and harmless to the progressing one, while an abort would kill
 *   real work.
 */
import { isWorkerOp, type CanonicalMiddleware } from "./types.js";
import { getMiddlewareState } from "./state.js";
import { createLogger } from "../../logger.js";

const logger = createLogger("canonical-loop.mid-turn-stale");

const MIN_ITERATION = 5;
const STALE_WINDOW = 3;

// Tools that produce a real side effect (so they count as evidence and don't
// read as committing) yet can be called turn after turn against a goal they
// can't reach — the "productive-looking spin". Browser is the observed case
// (scrape / consent-wall loops); http_request is the obvious next member if it
// ever shows the same pattern.
const SPIN_PRONE_ACTION_TOOLS: ReadonlySet<string> = new Set(["browser"]);

interface MidTurnStaleState {
  // Branch 1 two-strike flag.
  nudged: boolean;
  // Branch 2 one-shot flag.
  spinNudged: boolean;
  // Per-turn dominant spin-prone tool, "" when the turn was mixed/empty or
  // touched anything else (which breaks the monotony streak). Capped to the
  // window — only the recent tail matters.
  recentDominantTools: string[];
}

function createState(): MidTurnStaleState {
  return { nudged: false, spinNudged: false, recentDominantTools: [] };
}

const STALE_NUDGE = [
  "Your last 3 actions produced no new evidence — same tools, same arguments, same empty results. You're spinning. Change approach NOW:",
  "  - If you're using browser.evaluate or browser.click on a new page, FIRST call browser.snapshot to see the actual DOM and find correct selectors.",
  "  - If a tool keeps returning the same error, read the error text and use a different tool / different arguments.",
  "  - If you're stuck on auth / captcha / login, ask the user to help instead of retrying.",
  "If the next iteration also produces no new evidence, the turn will be aborted automatically.",
].join("\n");

function spinNudge(tool: string): string {
  return [
    `You've used the ${tool} tool on every one of the last ${STALE_WINDOW} turns and committed nothing.`,
    "Stop and check: are these actions actually getting you closer to what the user asked for, or are you repeating the same kind of action against the same wall?",
    "  - If a login, captcha, consent screen, or a page too dynamic to read is blocking you, you CANNOT click your way past it. Stop now and tell the user the exact blocker and what you need from them (credentials, API access, a different source).",
    "  - If you ARE making progress, continue — but say in one line what concretely advanced.",
  ].join("\n");
}

export const midTurnStaleMiddleware: CanonicalMiddleware = {
  name: "mid-turn-stale",

  // NOT gated to worker ops: the second-strike abort is the circuit-breaker
  // that caps a spinning interactive/voice turn. Gating it off let a looping
  // voice turn spam to max-iterations.
  beforeTurn(ctx) {
    if (ctx.turnIdx < MIN_ITERATION) return { kind: "continue" };
    if (ctx.committingToolsThisOp.size > 0) return { kind: "continue" };

    const state = getMiddlewareState<MidTurnStaleState>(
      ctx.op.id,
      "mid-turn-stale",
      createState,
    );

    // Branch 1 — flat evidence.
    if (ctx.evidenceHistory.length >= STALE_WINDOW) {
      const tail = ctx.evidenceHistory.slice(-STALE_WINDOW);
      if (tail.every(v => v === tail[0])) {
        if (!state.nudged) {
          state.nudged = true;
          // The visible "you're spinning, change approach" nudge is worker-only
          // — on interactive/voice the model verbalizes it. Interactive turns
          // skip straight to silent first-strike; the second strike still
          // aborts (below), so the circuit-breaker that caps a spinning voice
          // turn stays intact.
          if (isWorkerOp(ctx)) {
            logger.warn(`first-strike nudge: evidence flat for ${STALE_WINDOW} turns`);
            return { kind: "nudge", message: STALE_NUDGE, reason: "stale-warning" };
          }
          logger.warn(`first-strike (interactive, silent): evidence flat for ${STALE_WINDOW} turns`);
          return { kind: "continue" };
        }
        logger.warn(`second-strike abort: evidence still flat after nudge`);
        return {
          kind: "abort",
          reason: "mid-turn-stale",
          message: "Mid-turn evidence stale (no progress after recovery nudge — likely browser tool selectors blind, auth wall, or wrong tool for the job)",
        };
      }
    }

    // Branch 2 — monotonous action. Fires on every lane: the whole point is to
    // make the model verbalize the blocker to the user, which is exactly what
    // we want spoken aloud / shown in chat.
    if (
      !state.spinNudged &&
      state.recentDominantTools.length >= STALE_WINDOW &&
      state.recentDominantTools.every(t => t !== "" && t === state.recentDominantTools[0])
    ) {
      state.spinNudged = true;
      const tool = state.recentDominantTools[0];
      logger.warn(`monotonous-action nudge: ${tool} dominated ${STALE_WINDOW} turns with no commit`);
      return { kind: "nudge", message: spinNudge(tool), reason: "no-progress-spin" };
    }

    return { kind: "continue" };
  },

  // Record this turn's dominant tool for Branch 2. A turn counts toward the
  // monotony streak only when its sole successful tool is a spin-prone action
  // tool; any other tool, a mix, an empty turn, or all-failed results writes ""
  // and breaks the streak.
  afterToolExecution(ctx) {
    const state = getMiddlewareState<MidTurnStaleState>(
      ctx.op.id,
      "mid-turn-stale",
      createState,
    );
    const okTools = new Set<string>();
    for (const tr of ctx.toolResults) {
      if (tr.status === "error" || tr.status === "cancelled") continue;
      okTools.add(tr.toolName);
    }
    let dominant = "";
    if (okTools.size === 1) {
      const only = [...okTools][0];
      if (SPIN_PRONE_ACTION_TOOLS.has(only)) dominant = only;
    }
    state.recentDominantTools.push(dominant);
    if (state.recentDominantTools.length > STALE_WINDOW) state.recentDominantTools.shift();
    return { kind: "continue" };
  },
};
