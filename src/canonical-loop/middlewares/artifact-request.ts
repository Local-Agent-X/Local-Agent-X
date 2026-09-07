/**
 * Artifact-request nudge — when the user reports a symptom the agent cannot
 * observe with its own tools, ASK for the missing artifact early instead of
 * spending the whole budget guessing.
 *
 * The incident this exists for: a user reported "there is a grey bar above the
 * nav bar on mobile". The agent could render the page, but only at a DESKTOP
 * viewport, where the bar does not appear. It measured that desktop rendering
 * ~110 turns and ~$27 deep, concluding "clean" each time, and never once asked
 * for a screenshot. The moment the user supplied one, the cause was identified
 * in minutes.
 *
 * The rule the loop was missing: when the user reports a symptom the agent
 * cannot reproduce with its own tools, requesting the missing artifact is the
 * FIRST move, not the last. Asking is a complete outcome, not a failure.
 *
 * ── Why this is not budget-ladder ──────────────────────────────────────────
 * budget-ladder (order 195) is driven by the BUDGET CLOCK alone: it needs
 * `maxIterations >= 40`, fires at 25/50/75% of it, never reads
 * `ctx.userMessage`, and therefore cannot fire before turn 10 even in the most
 * generous case. It asks a general "step back" question of ANY long-running op.
 * This gate is driven entirely by the USER'S OPENING MESSAGE, fires in the
 * first handful of turns (before the budget ladder's first rung can exist), and
 * asks one specific question: request the artifact. The two literally cannot
 * fire on the same turn — see NUDGE_TURN / LAST_TURN below.
 *
 * ── Detection (deliberately precise, not recall-maximising) ────────────────
 * A false nudge on every bug report would be noise, so ALL of these must hold:
 *
 *   1. INTERACTIVE lane only. A background worker has nobody to ask; telling it
 *      to request a screenshot would just stall it (`when` predicate).
 *   2. The op is EARLY — the first beforeTurn at turn NUDGE_TURN..LAST_TURN.
 *      Fires at most ONCE per op (per-op state).
 *   3. The message reads as a DEFECT REPORT (something is wrong / broken /
 *      looks off / still happening), not a build/implement/research request.
 *   4. The defect is described as an UNSHARED OBSERVATION — something the user
 *      sees on their device, viewport, browser or session, which the agent's
 *      own rendering does not reproduce ("on mobile", "on my phone", "when I
 *      click", "it looks…"). This is the precision knob: a plain "the tests are
 *      failing" is observable by the agent and stays silent.
 *   5. The user has NOT already supplied the artifact — no screenshot mention,
 *      no pasted stack trace, no code fence, no file:line, no error code. If
 *      the evidence is already in the message there is nothing to ask for.
 *
 * Cheap and deterministic on purpose: this runs on every turn of every
 * interactive op, so it is a regex triple, not an LLM call. An LLM classifier
 * would raise recall, but recall is explicitly NOT what this gate optimises —
 * and the cost of one classifier call per turn per op is not justified by it.
 *
 * Nudges only. It never aborts or suspends: the worst case is one extra
 * paragraph of guidance on a turn that was going to run anyway.
 */
import { type CanonicalMiddleware, isWorkerOp } from "./types.js";
import { getMiddlewareState } from "./state.js";

/**
 * The turn the nudge lands on. Not turn 0: the agent deserves a look at the
 * problem before being told to ask about it, and a nudge injected before the
 * very first model call reads as pre-emptive nagging. By turn 2 an agent that
 * COULD reproduce the symptom generally has, and one that could not is about to
 * start guessing — which is exactly the moment to ask.
 */
const NUDGE_TURN = 2;

/**
 * Past this the window closes and the gate stays silent forever. "Ask first" is
 * the entire point; a mid-run reminder is budget-ladder's job, and firing late
 * would reproduce the very failure this exists to prevent (asking last).
 *
 * The window [2,6] also PROVES non-overlap with budget-ladder: its earliest
 * possible rung is floor(40 * 0.25) = turn 10, and 40 is its minimum budget, so
 * no op exists on which both can fire on the same turn.
 */
const LAST_TURN = 6;

/** Below this a message is too terse to classify with any confidence. */
const MIN_MESSAGE_LEN = 12;

/**
 * (3) The report describes something WRONG. Curated rather than broad — every
 * alternative here is a word people use about a defect and rarely about a
 * feature request. The trailing alternatives cover the pure visual-artifact
 * report ("there's a grey bar", "there is a weird gap"), which names no failure
 * verb at all and was the exact shape of the incident message.
 */
const DEFECT_CUE =
  /\b(broken|breaks|bug|glitch|glitchy|weird|wrong|misaligned|overlapping|overlaps|cut off|blank|flicker\w*|stuck|frozen|freezes|crash\w*|fails?|failing|error|not working|doesn'?t work|does not work|won'?t (load|open|work|show|render|submit|save)|isn'?t (working|loading|showing|rendering)|still (there|happening|showing|broken|doing)|looks? (wrong|bad|weird|off|broken)|shouldn'?t be (there|showing)|there'?s an? [\w-]+ ?[\w-]* (bar|gap|box|border|line|strip|space|banner|overlay|margin)|there is an? [\w-]+ ?[\w-]* (bar|gap|box|border|line|strip|space|banner|overlay|margin))\b/i;

/**
 * (4) The observation belongs to the USER'S environment, not one the agent
 * shares. This is the precision gate: without it every "the build is broken"
 * would nudge, and the agent CAN observe a broken build.
 */
const UNSHARED_OBSERVATION_CUE =
  /\b(on (my|the) (phone|mobile|ipad|tablet|laptop|machine|computer|screen|device|end|side)|on mobile|mobile|small screen|in (safari|chrome|firefox|edge|the app|the browser)|dark mode|light mode|when i (click|tap|scroll|open|type|hover|refresh|load|press|visit)|i (see|saw|get|got|keep getting)|i'?m seeing|i am seeing|it looks|looks like|shows? up|showing up|appears|for me|my (browser|phone|screen|machine|account|session))\b/i;

/**
 * (5) Evidence already in hand — if any of this is present there is nothing
 * left to request, and nudging would tell the agent to ask for what it was just
 * given. Covers: a fenced paste, an explicit screenshot/attachment mention, a
 * stack trace, a file:line reference, and a machine error code.
 */
const ARTIFACT_ALREADY_SUPPLIED: RegExp[] = [
  /```/,
  /\b(screen ?shot|attached|attachment|see the (image|photo|picture)|\[image\])\b/i,
  /\.(png|jpe?g|gif|webp|heic)\b/i,
  /^\s+at\s+\S+/m,
  /\bTraceback \(most recent call last\)/,
  /\b[\w./-]+\.(ts|tsx|js|jsx|mjs|cjs|py|go|rs|java|rb|php|css|scss|html|json|yml|yaml):\d+/,
  /\b(TS\d{4}|ERR_[A-Z_]+|ENOENT|ECONNREFUSED|HTTP \d{3}|exit code \d+)\b/,
];

/**
 * (3, negative) A build/implement/research request. These legitimately contain
 * defect vocabulary ("build a page that doesn't flicker", "research why X
 * fails") but are not symptom reports, and asking the user for a screenshot of
 * something that does not exist yet is nonsense.
 */
const BUILD_REQUEST_CUE =
  /(^\s*(please\s+)?(build|implement|create|add|write|make|design|refactor|research|investigate|set ?up|scaffold|generate|port|migrate|document|review|audit)\b|\b(can|could) you (build|make|create|add|implement|write|design|research)\b|\b(build|create|implement|write) (me )?an? [\w-]+)/i;

/** True when the message reads as "I am seeing something wrong that you cannot
 *  see, and I have not shown it to you". Pure + exported for direct testing. */
export function looksLikeUnobservableSymptomReport(message: string): boolean {
  const t = (message || "").trim();
  if (t.length < MIN_MESSAGE_LEN) return false;
  if (BUILD_REQUEST_CUE.test(t)) return false;
  if (ARTIFACT_ALREADY_SUPPLIED.some((re) => re.test(t))) return false;
  return DEFECT_CUE.test(t) && UNSHARED_OBSERVATION_CUE.test(t);
}

interface FiredFlag {
  fired: boolean;
}

const STATE_KEY = "artifact-request";

const NUDGE_MESSAGE = [
  "SYSTEM: the user reported a symptom in THEIR environment — a device, viewport, browser, account or session you are not looking at. Before you spend more turns on this, settle one question:",
  "  Can you actually REPRODUCE what they described, with your own tools, under the same conditions they described it?",
  "If you cannot — if you are inspecting a desktop rendering of a mobile complaint, a different browser, your own account, or code you are reasoning about rather than output you have observed — then ASK NOW. Do not keep measuring the thing you CAN see and reporting it clean; that is not evidence about the thing they can see and you cannot.",
  "Ask for the specific artifact that would let you see it, named concretely — for example:",
  "  - a screenshot or screen recording of the problem (say what should be visible in frame)",
  "  - the exact device, OS, browser and window/viewport size",
  "  - the URL or screen they were on, and the exact steps that reproduce it",
  "  - the console/network error text, the log lines, or the failing input that triggers it",
  "Ask for the ONE or TWO that would actually be decisive, say briefly why you need them, and stop there.",
  "Asking the user for evidence you cannot obtain yourself is a COMPLETE outcome, not a failure or a punt. Guessing for another twenty turns is the failure.",
].join("\n");

export const artifactRequestMiddleware: CanonicalMiddleware = {
  name: "artifact-request",

  // Interactive lanes only (chat + voice). A worker op — agent_spawn, build,
  // background/cron — has no user in the loop to answer, so the nudge would
  // push it toward stopping with a question nobody will read. `isWorkerOp` is
  // the canonical interactive-vs-worker split.
  when: (ctx) => !isWorkerOp(ctx),

  beforeTurn(ctx) {
    if (ctx.turnIdx < NUDGE_TURN || ctx.turnIdx > LAST_TURN) return { kind: "continue" };
    if (!looksLikeUnobservableSymptomReport(ctx.userMessage)) return { kind: "continue" };

    const flag = getMiddlewareState<FiredFlag>(ctx.op.id, STATE_KEY, () => ({ fired: false }));
    if (flag.fired) return { kind: "continue" };
    flag.fired = true;

    return { kind: "nudge", message: NUDGE_MESSAGE, reason: "artifact-request" };
  },
};
