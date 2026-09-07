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
 * ── The firing rule, in one sentence ───────────────────────────────────────
 * Fire once, on an early turn of a CHAT op, when the message that opened this
 * op describes a defect the user is looking at in their own environment, names
 * no thing the agent could open or run for itself, is not a request to build /
 * regenerate something, is not a complaint relayed from a third party, and
 * carries no evidence (paste, screenshot, trace, log) already.
 *
 * ── Why this is not budget-ladder ──────────────────────────────────────────
 * budget-ladder (order 195) is driven by the BUDGET CLOCK alone: it needs
 * `maxIterations >= 40`, fires at 25/50/75% of it, and cannot fire before turn
 * 10 even in the most generous case. This gate is driven entirely by the user's
 * message, fires in the first handful of turns, and asks one specific question.
 * The window [2,6] proves non-overlap: budget-ladder's earliest possible rung is
 * floor(40 * 0.25) = turn 10 and 40 is its minimum budget.
 *
 * ── Precision is the whole design ──────────────────────────────────────────
 * A nudge on every bug report is noise, and noise here is expensive: it tells
 * the agent to stop and demand a screenshot for something it could have just
 * run. Four independent SUPPRESSORS run before the two positive cues, and each
 * one exists because a measured probe fired wrongly without it:
 *
 *   - AGENT_OBSERVABLE_SUBJECT — the user named a test, a build, a typecheck,
 *     CI, a deploy, or a repo path. "on my machine" / "I see" / "for me" do not
 *     make `npm test` unobservable; the agent can run it. This was the single
 *     largest false-positive source.
 *   - BUILD_VERB_ANYWHERE / BUILD_REQUEST_SHAPE — a request to build, rebuild,
 *     rewrite, draft or summarise. Anchoring only at `^` missed a trailing
 *     "…, rebuild it", which is the common shape.
 *   - RELAYED_COMPLAINT_CUE — the defect is quoted from a customer, a ticket or
 *     a bug report the user is asking to be summarised or answered. The user
 *     cannot produce a screenshot of someone else's phone on request.
 *   - ARTIFACT_ALREADY_SUPPLIED — evidence is in the message: fence, image,
 *     stack trace, error code, or an UNFENCED log paste (a shape the first cut
 *     missed entirely).
 *
 * Cheap and deterministic on purpose: this runs on every turn of every
 * interactive op, so it is a set of regexes over a length-BOUNDED string, not
 * an LLM call. See MAX_MESSAGE_LEN — an unbounded input on this path is a
 * server-wide stall, not a slow turn.
 *
 * Nudges only. It never aborts or suspends.
 */
import { type CanonicalMiddleware, isWorkerOp } from "./types.js";
import { getMiddlewareState } from "./state.js";

/**
 * The turn the nudge lands on. Not turn 0: the agent deserves a look at the
 * problem before being told to ask about it. By turn 2 an agent that COULD
 * reproduce the symptom generally has, and one that could not is about to start
 * guessing — which is exactly the moment to ask.
 */
const NUDGE_TURN = 2;

/**
 * Past this the window closes and the gate stays silent forever. "Ask first" is
 * the entire point; firing late would reproduce the very failure this exists to
 * prevent. The window is a RANGE, not a single turn, because five earlier
 * beforeTurn middlewares can each nudge and host.ts short-circuits on the first
 * non-continue — so turn 2 is frequently preempted and turn 3..6 is where this
 * actually lands. Tests pin every turn in the range independently.
 */
const LAST_TURN = 6;

/** Below this a message is too terse to classify with any confidence. */
const MIN_MESSAGE_LEN = 12;

/**
 * Hard input bound, checked BEFORE any regex touches the string. Two reasons,
 * both load-bearing:
 *
 *   (a) CORRECTNESS. A message this long is a PASTE — a log, a stack, a CSS
 *       dump. The evidence is already in hand, so there is nothing to ask for.
 *   (b) AVAILABILITY. `beforeTurn` runs SYNCHRONOUSLY on the server event loop,
 *       on up to five turns of every interactive op. An unbounded regex scan
 *       here does not slow one turn down, it freezes every op on the box. The
 *       first cut of this file had no upper bound at all and paired adjacent
 *       unbounded token classes; a 160KB paste was measured at 16.8 SECONDS,
 *       200KB at ~80s. Both halves are fixed: this bound, and the regexes below
 *       which no longer contain a `[\w-]+ ?[\w-]*` shape.
 *
 * Anything above this returns false without matching. See the perf test.
 */
const MAX_MESSAGE_LEN = 4000;

/** A message with more lines than this is a paste, whatever its length. Catches
 *  the unfenced log dump that the line-shape regexes below miss. */
const MAX_PASTE_LINES = 8;

/**
 * (positive 1a) The report describes something WRONG. Curated rather than
 * broad — every alternative is a word people use about a defect and rarely
 * about a feature request.
 */
const DEFECT_VERB_CUE =
  /\b(?:broken|breaks|bug|glitch|glitchy|weird|wrong|misaligned|overlapping|overlaps|cut off|blank|flicker\w*|stuck|frozen|freezes|crash\w*|fails?|failing|error|not working|doesn'?t work|does not work|won'?t (?:load|open|work|show|render|submit|save)|isn'?t (?:working|loading|showing|rendering)|still (?:there|happening|showing|broken|doing)|looks? (?:wrong|bad|weird|off|broken)|shouldn'?t be (?:there|showing))\b/i;

/**
 * (positive 1b) The pure VISUAL-ARTIFACT report, which names no failure verb at
 * all — "a grey bar", "a weird gap". This is the incident's own shape.
 *
 * Deliberately matched as ADJECTIVE + NOUN and nothing else. The first cut
 * reached this case only through a literal "there is/there's a …", which (i)
 * missed "fix the grey bar above the nav on mobile" — the incident restated as
 * an instruction, and the single worst recall hole in the gate — and (ii) used
 * `an? [\w-]+ ?[\w-]* (bar|…)`, two adjacent unbounded token classes, which is
 * the catastrophic-backtracking shape measured above. Two adjacent alternations
 * of literals separated by one `\s+` cannot backtrack super-linearly.
 */
const VISUAL_ARTIFACT_CUE =
  /\b(?:gr[ea]y|black|white|blue|red|green|yellow|orange|purple|pink|weird|strange|odd|extra|random|stray|thin|thick|blank|empty|huge|big|large|small|tiny|unwanted|ugly|mystery|double|duplicate)\s+(?:bars?|gaps?|boxe?s?|borders?|lines?|strips?|spaces?|banners?|overlays?|margins?|padding|whitespace|scrollbars?|outlines?|shadows?)\b/i;

/**
 * (positive 2) The observation belongs to the USER'S environment, not one the
 * agent shares. `looks like` was removed from this list: it is an epistemic
 * hedge ("It looks like the retry logic is broken"), not an observation, and it
 * was firing the gate on pure code reasoning.
 */
const UNSHARED_OBSERVATION_CUE =
  /\b(?:on (?:my|the) (?:phone|mobile|ipad|tablet|laptop|machine|computer|screen|device|end|side)|on mobile|mobile|small screen|in (?:safari|chrome|firefox|edge|the app|the browser)|dark mode|light mode|when i (?:click|tap|scroll|open|type|hover|refresh|load|press|visit)|i (?:see|saw|get|got|keep getting)|i'?m seeing|i am seeing|it looks|shows? up|showing up|appears|for me|my (?:browser|phone|screen|machine|account|session))\b/i;

/**
 * (suppressor 1) The named subject is something the agent can RUN OR OPEN
 * ITSELF. "the unit test fails on my machine", "tsc is broken on my machine, I
 * see a type error", "deploy is broken, I see the CI job failing", "the retry
 * logic is broken in src/x.ts", "please fix the CSS" — every one of these has a
 * personal-observation phrase in it, and in every one of them the right move is
 * to go run/read the thing, not to demand a screenshot of it.
 */
const AGENT_OBSERVABLE_SUBJECT: RegExp[] = [
  /\b(?:unit |integration |e2e |smoke |snapshot )?tests?\b|\btest suite\b/i,
  /\b(?:npm|yarn|pnpm|npx|bun|pytest|jest|vitest|mocha|cargo|gradle|maven|make|tsc|eslint|prettier|webpack|vite|rollup|docker|kubectl)\b/i,
  /\bthe (?:build|repo|repository|codebase|code|source|css|scss|sass|less|html|markup|stylesheet|server|logs?|config|configuration|schema|database|db|query|migration|pipeline|lint(?:er|ing)?|type ?check|compiler|bundle)\b/i,
  /\b(?:ci|cd|github actions|jenkins|circleci)\b/i,
  /\bdeploys?\b|\bdeployed\b|\bdeployment\b/i,
  /\btype ?(?:script )?error\b|\bcompil(?:e|es|ed|ing|ation)\b|\bstack trace\b/i,
  // A repo path — with or without a :line. The `:\d+` form belongs to
  // ARTIFACT_ALREADY_SUPPLIED (the user quoted a location out of a trace); a
  // BARE `src/x.ts` is not supplied evidence, it is the agent's own file.
  /(?:^|[\s("'`])[\w.-]*[\w-]\/[\w./-]+\.(?:ts|tsx|js|jsx|mjs|cjs|py|go|rs|java|rb|php|css|scss|sass|less|html|json|ya?ml|toml|sh)\b/i,
  /\b[\w-]+\.(?:ts|tsx|jsx|mjs|cjs|py|go|rs|java|rb|php|scss|sass|less|toml)\b/i,
];

/**
 * (suppressor 2a) Verbs that mean "produce or regenerate an artifact". Safe to
 * detect ANYWHERE in the message — none of them is common inside a symptom
 * description, and the trailing form ("…looks wrong on mobile, rebuild it") is
 * exactly what an `^`-anchored cue missed.
 */
const BUILD_VERB_ANYWHERE =
  /\b(?:re-?build|rebuilds?|re-?write|rewrites?|re-?design|redesigns?|re-?generate|regenerates?|scaffold|implement\w*|refactor\w*|draft|summari[sz]e[sd]?|summari[sz]ing)\b/i;

/**
 * (suppressor 2b) The AMBIGUOUS build verbs. These occur legitimately inside a
 * defect report ("it won't create the row"), so only a REQUEST shape counts:
 * the verb opens the message or a clause, or follows "can/could/would you".
 * Note `fix` is deliberately absent from both lists — "fix the grey bar above
 * the nav on mobile" is the incident itself, and suppressing it would restore
 * the recall hole VISUAL_ARTIFACT_CUE was widened to close.
 */
const BUILD_REQUEST_SHAPE =
  /(?:^|[.;!?\n]\s*|,\s*(?:and |then |also )?|\b(?:can|could|would|will) you )(?:please |pls |just |now )?(?:build|create|add|write|make|design|research|investigate|set ?up|generate|document|review|audit)\b/i;

/**
 * (suppressor 3) The complaint is RELAYED — quoted from a customer, a ticket,
 * a bug report. The user is a messenger here; they cannot go take a screenshot
 * of someone else's phone because the agent asked, and the actual request is
 * usually "draft a reply" or "summarise this".
 */
const RELAYED_COMPLAINT_CUE: RegExp[] = [
  /\b(?:customers?|clients?|users?|someone|somebody|colleagues?|my boss|support|qa|the team|people)\b[^.\n]{0,60}?\b(?:e-?mailed|wrote|reported|reports|reporting|says?|said|complain(?:ed|ing|s)?|messaged|told me|are seeing|is seeing)\b/i,
  /\b(?:bug report|support ticket|this (?:email|message|ticket|report|thread|complaint)|forwarded|on behalf of)\b/i,
  // A quoted span — the complaint verbatim. Double/smart quotes only: single
  // quotes collide with apostrophes ("doesn't work, there's a bar" would match).
  /["“][^"”\n]{12,200}["”]/,
];

/**
 * (suppressor 4) Evidence already in hand — nudging here would tell the agent
 * to ask for what it was just given. Covers a fenced paste, an explicit
 * screenshot/attachment, a stack trace, a file:LINE reference, a machine error
 * code, and an UNFENCED log paste (timestamped / levelled / `Caused by:` /
 * `SomethingError:` lines), which the first cut missed.
 */
const ARTIFACT_ALREADY_SUPPLIED: RegExp[] = [
  /```/,
  /\b(?:screen ?shot|screen ?recording|attached|attachment|see the (?:image|photo|picture|video)|\[image\])\b/i,
  /\.(?:png|jpe?g|gif|webp|heic|mp4|mov)\b/i,
  /^\s+at\s+\S+/m,
  /\bat [\w.$<>]+ \([^)\n]{0,200}:\d+(?::\d+)?\)/,
  /\bTraceback \(most recent call last\)/,
  /\b[\w./-]+\.(?:ts|tsx|js|jsx|mjs|cjs|py|go|rs|java|rb|php|css|scss|html|json|yml|yaml):\d+/,
  /\b(?:TS\d{4}|ERR_[A-Z_]+|ENOENT|ECONNREFUSED|HTTP \d{3}|exit code \d+)\b/,
  /^\s*(?:\[?\d{4}-\d{2}-\d{2}[T ]|\d{1,2}:\d{2}:\d{2}|(?:ERROR|WARN|WARNING|FATAL|DEBUG|INFO|TRACE)\b|[A-Za-z_$][\w$]*(?:Error|Exception):|Uncaught\b|Caused by:)/m,
];

/** Newline count without allocating a split array. */
function lineCount(text: string): number {
  let n = 1;
  for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10) n++;
  return n;
}

/** True when the message reads as "I am seeing something wrong that you cannot
 *  see, and I have not shown it to you". Pure + exported for direct testing. */
export function looksLikeUnobservableSymptomReport(message: string): boolean {
  const t = (message || "").trim();
  if (t.length < MIN_MESSAGE_LEN) return false;
  // Bound the input BEFORE matching — see MAX_MESSAGE_LEN. This is both the
  // availability fix and a correctness one: a paste IS the artifact.
  if (t.length > MAX_MESSAGE_LEN) return false;
  if (lineCount(t) > MAX_PASTE_LINES) return false;

  if (BUILD_VERB_ANYWHERE.test(t)) return false;
  if (BUILD_REQUEST_SHAPE.test(t)) return false;
  if (RELAYED_COMPLAINT_CUE.some((re) => re.test(t))) return false;
  if (AGENT_OBSERVABLE_SUBJECT.some((re) => re.test(t))) return false;
  if (ARTIFACT_ALREADY_SUPPLIED.some((re) => re.test(t))) return false;

  const defect = DEFECT_VERB_CUE.test(t) || VISUAL_ARTIFACT_CUE.test(t);
  return defect && UNSHARED_OBSERVATION_CUE.test(t);
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

  // CHAT ops only.
  //
  // - A worker op (agent_spawn, build, background, cron) has no user in the
  //   loop to answer, so the nudge would push it toward stopping with a
  //   question nobody will read. `isWorkerOp` is the canonical split.
  // - voice_turn is excluded even though it is also `lane: "interactive"`
  //   (voice-ws.ts:326). Every artifact this nudge names — a screenshot, a
  //   screen recording, pasted console/network error text, a viewport size — is
  //   something a person in a SPOKEN conversation cannot hand over, so on the
  //   voice lane the nudge is unanswerable by construction and the reply gets
  //   read aloud. Excluding beats rewording: a voice-appropriate artifact list
  //   ("describe what you see") is a different intervention with a different
  //   value, and it is not what the incident asked for.
  when: (ctx) => !isWorkerOp(ctx) && ctx.op.type !== "voice_turn",

  beforeTurn(ctx) {
    if (ctx.turnIdx < NUDGE_TURN || ctx.turnIdx > LAST_TURN) return { kind: "continue" };
    // `currentUserMessage`, NOT `userMessage`. The latter is the FIRST user row
    // in op_messages, and chat-runner/seed-messages.ts seeds the whole prior
    // conversation as user rows before appending the current one — so on every
    // op after a session's opening line it holds a STALE message. Reading it
    // here made the gate (a) miss every defect reported after the first line and
    // (b) re-fire the same nudge on turn 2 of every subsequent op in the
    // session, each with a fresh per-op flag, demanding a screenshot the user
    // had already supplied. See types.ts on both fields.
    if (!looksLikeUnobservableSymptomReport(ctx.currentUserMessage)) return { kind: "continue" };

    const flag = getMiddlewareState<FiredFlag>(ctx.op.id, STATE_KEY, () => ({ fired: false }));
    if (flag.fired) return { kind: "continue" };
    flag.fired = true;

    return { kind: "nudge", message: NUDGE_MESSAGE, reason: "artifact-request" };
  },
};
