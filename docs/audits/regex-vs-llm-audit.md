# Regex vs LLM Audit — Local Agent X

**Question being answered:** are we using regex in too many places where a small LLM call would do better?

**Short answer:** Yes — about a dozen hotspots. The codebase already has the right
plumbing (`src/llm-dispatch.ts`, `src/routing/llm-classifier.ts`,
`src/memory/curate-classifier.ts`) so wiring more LLM-backed classifiers is
mechanical — not architectural. The leverage spots are concentrated in three
buckets: (1) hallucination / action-claim verification, (2) topic and follow-up
classification inside the orchestrator, and (3) emotional / vulnerability /
contradiction detection that currently relies on keyword tables.

The `src/routing/` package is the gold-standard pattern for the rest of the
codebase to copy: regex first (cheap), LLM as a veto (accurate). Almost every
hotspot below should converge on that shape.

---

## 1. Hotspots that should move to LLM (ranked by leverage)

### 1.1. Action-claim hallucination guard — `src/agent-guards.ts:124-207`

**What it does:** decides whether an assistant reply makes a claim ("I added the
file", "Removed X", "Saved your prefs") that wasn't backed by a real tool call,
and if so injects a nudge that forces a retry.

**Regex approach:**
```ts
const ACTION_VERB_TO_TOOLS = [
  { verb: /\b(removed?|unpinned?|deleted?|dropped?|cleared?|unscheduled?)\b/i, tools: [...] },
  { verb: /\b(added?|pinned?|scheduled|created|wrote|built|saved|installed)\b/i, tools: [...] },
  { verb: /\b(notes?|noted|remembers?|...)\b/i, tools: ["memory_save", ...] },
  ...
];
const CLAIM_AT_REPLY_START_RE = /(?:^|\n)\s*[-*]?\s*(Removed|Unpinned|...)\b/i;
const CLAIM_FIRST_PERSON_RE = /\bI(?:'ve|'ll| have| will)?\s+(removed|...)\b/i;
```

A verb table is hand-mapped to a list of tool names, and a sentence must
*both* match a "claim shape" regex *and* a verb whose tool list intersects
this turn's `toolsCalledThisTurn`.

**Failure modes inevitably shipped:**

- **False positives that nudge legit work into a retry:** "I noted in the bash
  log that…" matches the `noted` verb (memory class), no `memory_save` was
  called → nudge fires, model gets pushed to call `memory_save` for what was
  actually just a recap of bash output. The author already knows about this
  ("noted" is the example in the file's own comment) and there's no clean fix
  in regex-land.
- **False positives on summaries of what just happened:** "Built **Kraken
  Bot** at workspace/apps/kraken-bot/..." gets flagged unless the literal verb
  `build_app` was the tool name (the agent wrote individual files via
  `write`/`edit`). The cure was to keep the verb regex generous and the tool
  list generous, which means either side mis-mapping ships a wrong nudge.
- **False negatives that let real hallucinations through:** "Patched the auth
  flow" — `patched` is in the verb regex but tools list is `[edit, write,
  http_request, ...]`. If the model wrote no file but said "patched", the
  presence of `bash` in the tool list makes it pass. Good.  But: "Sent it to
  Alex" (where "it" = report file the model never actually generated and
  never actually emailed) — `sent` is in the verb list, `email_send` isn't in
  the toolsCalledThisTurn (model called `bash` to `cat` something instead) →
  the nudge will fire. Half-right.
- **Locale / phrasing variations:** "Just pushed those changes" — `pushed`
  isn't in the verb tables. Real hallucination, no nudge.

The user already saw the exact shape of this bug tonight (the "stale prefix"
strip-filter ate a real assistant message because a nudge prefix collided —
same family of regex-matching-too-much).

**LLM-call alternative:** wrap `checkUnmatchedActionClaim` so the regex remains
the cheap pre-filter (returns "no claim shape detected" → null) but a `maybe`
branch escalates to a Haiku-4.5 yes/no:

> System: "An assistant reply may have claimed an action without doing it.
> Tools that ACTUALLY ran this turn: {names}. Reply has 'claimed' shape: yes.
> Decide: is this reply genuinely claiming an action that needed one of
> {expected_tools} but those weren't called? Reply: YES <reason> | NO <reason>."

Single-shot, ~250 input + 30 output tokens.

**Trade-offs:** +200ms on terminal turns where the regex already matched (a
small subset of all turns — most replies don't trip the verb regex at all).
$0.0004/call worst case on Haiku. We give up the deterministic guarantee but
gain the ability to actually distinguish "Built X" (recap of `write` calls)
from "Built X" (hollow promise).

**Verdict:** **HYBRID** — keep regex as cheap pre-filter, escalate to LLM
when regex says "claim shape detected and verb-tool intersection is empty".
This is the highest-leverage change in the file because it's the one that
fires user-facing nudge text most often, and false positives leak through to
the chat (the bug from tonight).

---

### 1.2. Conversational follow-up detector — `src/orchestrator/orchestrator.ts:53-65`

**What it does:** decides whether the user's current message is a short
"yeah, what happened" / "really?" / "tell me more" follow-up vs. a substantive
new ask. If it's a follow-up, the orchestrator drops every "session-scope"
signal (callbacks, recall, narratives) so prior memory doesn't bleed into
the answer.

**Regex approach:**
```ts
function isConversationalFollowup(message: string): boolean {
  if (wordCount > 8) return false;
  if (/^(yes|yeah|yep|yup|ok|okay|...)[.!?]*$/i.test(m)) return true;
  if (wordCount <= 6 && /^(what|why|how|when|where|...)\b/i.test(m)) return true;
  if (wordCount <= 8 && /\b(it|that|this|those|them|happened|...)\b/i.test(m)) return true;
  return false;
}
```

**Failure modes:**

- **False negatives that bleed:** "and then what" (4 words) doesn't match any
  branch — `and` doesn't open the W-pronoun list, `then what` isn't in the
  pronoun-anchored list. 4-word follow-up, classified as substantive, full
  recall fires.
- **False negatives for substantive short asks misclassified as follow-up:**
  "what is webrtc" (3 words) → matches `^what\b` branch → classified as
  follow-up → callback / recall signals get dropped. But this *is* a new
  substantive question and the user is going to wonder why the agent has no
  context about it.
- **Word-count is brittle:** "i mean what about the other one" (8 words)
  passes the 8-word ceiling on the pronoun branch but is exactly the case the
  branch is for; "tell me more about kraken btw" (6 words) is a substantive
  request to expand on a topic — not a follow-up — but matches the
  "tell me more" pronoun branch.
- **Pronoun overload:** the substring `/\bthis\b/` matches "i love this idea"
  (4 words but a substantive reaction worth recalling).

**LLM-call alternative:** `classifyFollowup(currentMessage, lastAssistantText)`
→ {is_followup: bool, reason: string}. Two-input prompt because follow-up-ness
is *relational* — it depends on what the assistant just said. The user's "what
about the other one" is a follow-up only if the prior turn presented
options.

**Trade-offs:** +100-200ms per turn that runs the orchestrator (every chat
turn that goes through the memory orchestrator), $0.0003/call on Haiku. Worth
it because this gates whether *every other* memory module gets shown — wrong
classification poisons the whole turn's context.

**Verdict:** **HYBRID** — keep the regex (catches the 80% obvious-yes acks
like "thanks" / "ok"). For everything *else* under 12 words, escalate. The
hottest miss is the medium-length 5-9 word case where regex word-count
heuristics are most brittle.

---

### 1.3. Topical-relevance gate — `src/orchestrator/orchestrator.ts:86-105`

**What it does:** decides whether a session-scope signal (e.g., "user asked
about logo work for baddies-and-daddies last Tuesday") is topically relevant
to the current message. Fires per-signal — drops signal if zero overlap with
the current message's keywords.

**Regex approach:** stop-word filter + 4-character minimum + 2+ overlap count.

```ts
function topicalKeywords(text: string): Set<string> {
  return new Set(text.toLowerCase().split(/\W+/).filter(w => w.length > 3 && !STOPWORDS.has(w)));
}
function signalTopicallyRelevant(messageWords: Set<string>, signalText: string): boolean {
  // counts shared words >= 2
}
```

**Failure modes:**

- **Synonyms slip:** message says "monetization plan", signal says
  "revenue strategy" — zero overlap, signal dropped. But it's the same topic.
- **Plural / inflection:** "logos" vs "logo" — different tokens, drop.
- **Common-noun overlap = false positive:** message: "let's audit the project
  config." Signal: "user is auditing the kraken project config." Keywords:
  `audit`, `project`, `config` — 3-overlap, signal injected. But the project
  in the message is OAX, the project in the signal is Kraken — totally
  unrelated. Bleed.
- **Domain-specific terms blocked by length filter:** "API" (3 chars) is
  filtered by `length > 3`. Signal about "the OpenAI API key issue" loses its
  most distinctive token.

This gate is the very last line of defense against bleed (the recent
`5863bb8` commit added it after follow-up-only gating wasn't enough). Each
miss either leaks a wrong-context signal into the prompt or drops a relevant
one.

**LLM-call alternative:** if you have N candidate signals, batch-classify them
in one Haiku call:

> "User just said: '{message}'. Which of these prior memory signals is
> *topically* relevant — same project, same topic, same person?
> Reply with a JSON array of indices that ARE relevant.
> 1. {signal1}
> 2. {signal2}
> ..."

**Trade-offs:** ~600 input + 30 output tokens once per turn for ~5-10
candidate signals. ~$0.0006 per turn on Haiku. Latency: one call instead of N
regex passes. Relevance jumps from "lexical overlap" to "semantic overlap"
without needing an embedding pipeline.

**Verdict:** **REPLACE WITH LLM (batched).** This is one of the highest-leverage
changes in the audit because it gates *every* session-scope memory module
output. Embedding-based cosine sim would also work but the SAX memory layer
already has embeddings — wiring them through here cleanly is more invasive
than a single Haiku call.

---

### 1.4. Approval & creation hallucination — `src/agent-guards.ts:59-103`

**What it does:** terminal-turn check — when the model emits text and zero
tool calls, scan for "I claimed to have created/scheduled/added X" or
"requires your approval" patterns and inject a corrective nudge.

**Regex approach:**
```ts
const APPROVAL_HALLUCINATION_RE = /\b(requires? approval|needs? your approv(al)?|please (approve|allow|confirm)...)\b/i;
const CREATION_HALLUCINATION_RE = /\bI('ve| have)?\s+(added|created|scheduled|saved|...)\s+/i;
const CREATION_HALLUCINATION_RE_2 = /(^|\n)\s*[-*]?\s*(Added|Created|Scheduled|Saved|Updated|...)\b/i;
const TOOL_ID_HALLUCINATION_RE = /(\b(sched_|job_|cron_)[a-zA-Z0-9_-]{6,}|(Job|Schedule|Mission|Task|Run)\s*ID[:=]?\s*...)/i;
```

**Failure modes:**

- **False positive on legitimate replies that quote the user:** user says
  "did you save the file?" → model replies "Yes — I've saved the file
  successfully (the bash diff shows it)." Even though `write` was called this
  turn and the only iter-0 check is the gate, on iter 0 the regex still trips
  because the criterion is "no tool calls in *this iteration*", not "no tool
  calls in the turn." If iter 0 was a clarifying-only iteration and iter 1
  wrote, the iter-0 check on the *iter-0 reply* still fires.
- **False positive on instructional content:** model replies "To pin
  something, you would say: 'Pinned X to sidebar'." → matches
  CREATION_HALLUCINATION_RE_2 sentence-start.
- **False negative on synonym claims:** "Your settings have been persisted"
  — no `saved`, no `updated`, no `created`. Real hallucination, no nudge.
- **TOOL_ID false positives:** any 8-hex commit hash quoted in a reply
  ("commit abc1234ef") matches the `[a-f0-9]{6,16}` pattern in the second
  half of the union.

**LLM-call alternative:** the regex already needs to fire *first* (it's cheap;
only ~5% of replies match), then escalate to Haiku:

> "Model reply (no tool calls this iteration): {text}. Tools called this
> turn (across all iterations): {tools}. Did the model claim a creation /
> approval / ID that wasn't actually executed? YES + which claim | NO."

**Trade-offs:** Same as 1.1 (action-claim) — these two should share the
abstraction.

**Verdict:** **HYBRID** — same machinery as 1.1. Best done together so the
abstraction lands once.

---

### 1.5. Auto-extract user/agent identity — `src/memory/auto-extract.ts:31-101`

**What it does:** scans every user message for "your name is X" / "my name is
Y" / "I have N kids" / "I work at Z" patterns to auto-update IDENTITY.md /
USER.md.

**Regex approach:**
```ts
const renamePatterns = [
  /(?:your name is|call yourself|you are|i'?ll call you|name you|be called)\s+["']?([A-Z][a-zA-Z0-9_ -]{0,20})["']?/i,
  /^([A-Z][a-zA-Z]{1,15})(?:\.|!|\s*$)/,
];
const factPatterns = [
  { pattern: /i have (\d+) (?:kids?|children|sons?|daughters?)/i, ... },
  { pattern: /i (?:live|moved|relocated) (?:in|to) ([A-Z][a-zA-Z\s,]+)/i, ... },
  ...
];
```

**Failure modes:**

- **The bare-capitalized-word-at-start regex** (`^([A-Z][a-zA-Z]{1,15})(?:\.|!|\s*$)`)
  fires on *every* short message that starts with a cap and ends with `.`.
  "Done.", "Cool.", "Nice." → tries to rename the agent to "Done" / "Cool" /
  "Nice" because they're 4-15 chars and not in STOP_WORDS. The
  STOP_WORDS check is the only thing keeping the agent from being renamed
  "Hello." every other turn. Real bug surface.
- **False negatives on common phrasings:** "let's call you Ari" — none of the
  rename patterns match (no `you are` / `your name is` / `name you`). Lost.
- **"I work at" with lowercase company:** "i work at xAI" — fails because
  the regex requires `[A-Z]` start on the captured group.
- **Plural / context-sensitive facts dropped:** "I have a son and a
  daughter" — neither `\d+` quantity matches, no save.

This is high-stakes because it writes to durable memory files. A wrong save
poisons future sessions until the user notices and corrects it.

**LLM-call alternative:** this is exactly what `curate-classifier.ts` was
built for — call it once with `kind: "fact"` semantics. The classifier already
returns `{teach, kind, why}`. Wire `autoExtractAndSave` to call
`classifyTeachMoment` first, then only run regex extraction if the classifier
confirms `kind === "fact"` AND the message looks like an identity statement.
Better: a *new* small classifier that returns the structured fields:

> "User message: '{message}'. Extract durable identity facts. Reply JSON:
> `{user_name?: string, agent_name?: string, location?: string, employer?:
> string, family_count?: number, none?: bool}`. Use null for unstated fields.
> Don't infer."

**Trade-offs:** +200ms only on messages that the classifier already flagged
as `kind:"fact"` (a small minority). Net cost: ~$0.0005/extracted-fact. We
gain the ability to never accidentally rename the agent to "Done" because the
LLM understands "Done." is an acknowledgement, not an identity.

**Verdict:** **REPLACE WITH LLM** (gated by the existing curate-classifier so
we don't pay the cost on every turn). This is also the *only* place in the
audit where the regex pattern can write to disk — a wrong fire here is
durable, not just a one-turn nudge. Highest dollar-per-bug ratio.

---

### 1.6. Emotion detection — `src/emotional-memory.ts:50-270`

**What it does:** classifies each user message into one of 10 emotions and
stores a record. The classification feeds adaptation hints
("user is frustrated → be concise").

**Regex approach:** keyword tables of ~12 phrases per emotion + emoji unicode
ranges + `!{2,}` / `\?{2,}` / CAPS-ratio heuristics.

```ts
const EMOTION_KEYWORDS = {
  happy: ["love it", "awesome", "great", ...],
  frustrated: ["annoying", "frustrating", "broken", "doesn't work", ...],
  ...
};
```

**Failure modes:**

- **Sarcasm flips polarity:** "oh great, another timeout" contains `great` →
  scored happy.
- **Negation:** "this is NOT awesome" contains `awesome` → scored happy.
- **Subject confusion:** "the build was annoying but now it works"  — both
  `annoying` and `works` keywords, but only `annoying` is in the table →
  scored frustrated even though the user is reporting success.
- **Non-listed words:** "this is mid" / "ngmi" / "L" — modern affect
  vocabulary not in any list.
- **CAPS heuristic:** code blocks, ALL-CAPS variable names in pasted code,
  acronyms ("API API SDK") all push toward `angry` / `excited`.
- **Compound moods:** "stressed but excited" — both fire, the higher-scored
  one wins arbitrarily.

The downstream adaptation hint pushes the model into different reply
modes. Wrong emotion → wrong tone for the next reply ("user is upset,
acknowledge frustration directly" when the user is actually celebrating).

**LLM-call alternative:** Haiku one-shot with the same 10-class enum.
~150 input + 20 output tokens. The classifier already catches sarcasm,
negation, and modern vocabulary trivially. Or replace the whole module with a
*pure* "should the agent acknowledge a strong negative emotion in its next
reply" gate (yes/no) — most of the granular emotion data is unused beyond
the adaptation hint.

**Trade-offs:** ~$0.0002/turn if always on. Most turns don't need emotion
classification (it's only displayed in profile aggregates and used for
adaptation hints) — we can sample, e.g., classify only when a high-confidence
emotional trigger word fires.

**Verdict:** **HYBRID** — keep the keyword scan as a cheap "is there
*any* emotion signal here" pre-filter (most messages are emotionally
neutral). When at least one keyword fires, escalate to a 5-class LLM call
(positive / negative / neutral / frustrated / stressed) — collapse the
10-class taxonomy to what actually drives behavior.

---

### 1.7. Vulnerability detection — `src/vulnerability-awareness.ts:56-130`

**What it does:** scans for sensitive disclosures (mental health, grief,
financial distress, abuse) so the agent can handle them with care and tag
them as never-surface-casually.

**Regex approach:** keyword lists per category — "depression" / "anxiety" /
"died" / "broke up" / "diagnosed with" — annotated with sensitivity tier.

**Failure modes:**

- **False positives on lyrics / quotes / discussions of OTHERS:** "user is
  reading a book about depression" → tagged as user disclosing depression.
- **False positives on technical terms:** "I diagnosed the production
  outage" → matches `diagnosed with` only if `with` follows, but the prior
  literal `diagnosed` partial isn't there — false negative example actually.
  Real false positive: "anxiety attack on the production server" (wishful)
  — `anxiety` alone matches.
- **False negatives on indirect disclosure:** "I haven't been sleeping. I
  cry in my car at lunch." Zero keyword hits despite being a textbook
  disclosure of distress.
- **Subject ambiguity:** "my friend's dad just passed" — `passed away` matches
  → tagged as user-grief, not friend-grief. The regex can't see whose family
  member died.

The downstream effect of a false positive is wrong: a future-session
"sacred memory" tag the user never agreed to. False negatives are also bad —
they miss the disclosure entirely.

**LLM-call alternative:** classifier returns
`{is_personal_disclosure: bool, category: enum, severity: enum,
about_user_themselves: bool}`. The `about_user_themselves` field alone fixes
the friend / family confusion that regex literally can't.

**Trade-offs:** ~$0.0003/turn if always on, much less if gated by keyword
pre-filter. The detection bar should be *cautious* (high recall, errors
toward false positive) — but errors should be reviewable, not silently
written to durable memory. Pair with curate-classifier-style confirmation.

**Verdict:** **HYBRID** — regex for the obvious-yes (death-of-immediate-family,
self-harm keywords) where false positive cost is low, LLM for the rest.

---

### 1.8. Conversation compaction — `src/conversation-compactor.ts:49-120`

**What it does:** when message history exceeds 80% of the context budget,
"compact" old messages into a summary and replace them.

**Regex approach:** there isn't really regex here — but there's no LLM call
either. Compaction is **substring truncation**: take each old message, slice
to 200/300 chars, prepend `[user]` / `[assistant]` / `[tool result]`, and call
that the summary. Then it stuffs the last 20 such truncations into a single
synthetic system message.

**Failure modes:**

- **Information loss is total in the middle of long messages:** a user
  message that's "I want X. The constraint is Y. The reason this matters
  is Z. Don't do A under any circumstances." gets truncated to "I want X.
  The constraint is Y." — the don't-do-A constraint is gone forever.
- **Tool results get cut at 300 chars:** the *tail* of a long tool result
  (where errors usually live) is gone.
- **The "summary" is just a concatenation:** there is no actual summary, just
  prefix + slice. The model is then told "Summary of earlier conversation:"
  followed by 20 truncated bullet points, which is misleading.

`src/providers/sanitize.ts:truncateHistory` does the same thing in a
different file — wraps trimmed text in `<prior_user>` / `<prior_assistant>`
tags. Two copies of the same truncate-and-pretend-it's-a-summary pattern.

**LLM-call alternative:** when compaction triggers, send the to-be-dropped
messages to a `claude-haiku-4-5` summarization call:

> "Summarize this prior conversation segment in 8 bullets, preserving:
> (a) decisions made, (b) constraints stated, (c) facts about the user,
> (d) outstanding asks. Skip filler."

**Trade-offs:** This is a relatively expensive call by the standards of
this audit (potentially 10k+ input tokens — the *to-be-dropped messages
themselves*). On Haiku that's ~$0.01 *per compaction event*, but compaction
fires rarely (only when context is full). Compared to the consequence of the
agent forgetting half the conversation context, $0.01 is nothing.

**Verdict:** **REPLACE WITH LLM.** Truncation isn't summarization. The
current code is named `compactMessages` but does string slicing — this is the
clearest "regex (or worse) where LLM is required" case in the audit. Also:
fold the duplicate code in `src/providers/sanitize.ts:truncateHistory` into
the same compactor.

---

### 1.9. Triage module activation — `src/orchestrator/triage.ts:6-77`

**What it does:** decides which memory modules (vulnerability,
correction-learning, contradiction-detector, narrative-memory, etc.) are
worth running this turn. Cheap binary "should I run this expensive module?"
gate.

**Regex approach:** keyword-list `.includes()` / regex test against the user
message:

```ts
if (SENSITIVE_KEYWORDS.some(kw => msg.includes(kw))) result.conditional.push("vulnerability-awareness");
if (CORRECTION_KEYWORDS.some(kw => msg.includes(kw))) result.triggered.push("correction-learning");
if (FACT_PATTERNS.some(p => p.test(input.message))) result.triggered.push("contradiction-detector");
if (STORY_PATTERNS.some(p => p.test(input.message))) result.scheduled.push("narrative-memory");
```

**Failure modes:**

- **CORRECTION_KEYWORDS** = `["no", "wrong", "incorrect", "actually", ...]` —
  every "actually let me try X" trips correction-learning, which then
  spends a real LLM call on a non-correction.
- **STORY_PATTERNS** like `\byesterday|last (week|month|night|year)\b` — fires
  on "the build broke yesterday" → narrative-memory loads, finds nothing.
- **SENSITIVE_KEYWORDS** = `["died", "death", ...]` — same false-positive
  surface as 1.7.
- **FACT_PATTERNS** like `\bi (am|work|live|...)\b` — fires on "I am going to
  bed" → contradiction-detector loads, finds nothing about a contradiction.

These misfires don't crash anything; they spend latency and wake up modules
that go on to do their own (also-regex) classification.

**LLM-call alternative:** this is a *batched* multi-label classification —
"which of [vulnerability, correction, narrative, contradiction] should look at
this message?" — Haiku one-shot.

**Trade-offs:** the triage call replaces 4-6 independent module entry costs
with one call. It's cheaper end-to-end than the current per-module
LLM-when-loaded pattern.

**Verdict:** **REPLACE WITH LLM** *only after* the per-module classifiers
move to LLM (1.5, 1.6, 1.7). If the modules themselves stay regex-based, the
triage gate is the one place where regex is acceptable because everything
downstream is also regex (errors-compound-but-don't-grow).

---

### 1.10. Memory-curate regex pre-stage — `src/agent-request/prepare-request.ts:196-203`

**What it does:** before the curate-classifier (LLM) runs, two cheap regex
checks decide whether to skip the LLM call entirely.

**Regex approach:**
```ts
if (/\b(always|never|next time|from now on|i prefer|i like to|i usually|please remember|...)\b/i.test(message)) {
  boostNudgePriority(sessionId, "preference-stated");
  regexBoosted = true;
}
if (/\b(remember (this|that)|save this|note this|keep in mind that)\b/i.test(message)) {
  boostNudgePriority(sessionId, "explicit-remember");
}
```

**Failure modes:**

- "I always lose track of which file this is in" → matches `always` →
  treated as preference-stated → memory boost. But no preference exists.
- "Never mind" / "never been sure" / "from now on let me think about this
  more" → preference boost on conversational filler.

**LLM-call alternative:** the classifier *already exists* (curate-classifier).
The regex pre-stage exists to *skip* the classifier when matched — but the
matches are wrong often enough that we boost on noise.

**Verdict:** **KEEP REGEX, NARROW PATTERNS.** The cheap-skip is the right
shape; the patterns just need to be more conservative ("from now on always" /
"in the future I want", not bare `always`). LLM call is too expensive to make
on every message — keep this gate but tighten it.

---

## 2. Hotspots that should stay regex

These are doing real-deterministic work where regex is the correct tool.

- **`src/sanitize.ts:20-67`** — prompt-injection patterns (`ignore previous
  instructions`, `jailbreak`, `DAN mode`, JWT/SK key shapes, AWS access keys,
  GitHub tokens). Regex is right because the failure mode of LLM-as-classifier
  on security primitives is "model hallucinates an exception" — too risky.
  Belt-and-suspenders: keep regex, don't add LLM.
- **`src/memory/utils.ts:56-67`** — credential redaction. Pure pattern —
  `eyJ...` JWTs, `ghp_...`, `xoxb-...`, `AKIA[0-9A-Z]{16}`. Regex is the
  industry standard.
- **`src/memory/utils.ts:102-124`** — `parseFactLine` parsing W/B/O/S kind
  prefixes from daily-log markdown. Structured input we wrote ourselves.
- **`src/agent-guards.ts:472`** — `GIT_COMMIT_OUTPUT_RE` matching
  `[main abc1234] commit` patterns from git's stdout. Structured tool output
  → regex parse is correct.
- **`src/agent-guards.ts:516`** — `PROGRESS_EMPTY_RE` for `Searched N files,
  0 results`. Structured output of our own search tools.
- **`src/threat-engine.ts`** — exfil pattern detection (encoding command after
  sensitive read). Security primitive.
- **`src/routing/regex-rules.ts:DISCUSS_PREFIX_RE`** — slash-command detection
  (`/discuss`, `/chat`, `/talk`, `/inline`). Slash commands are exact-match
  enums.
- **`src/memory/auto-extract.ts` CREDENTIAL_PATTERNS** — same as utils.ts.
- **`src/contradiction-detector.ts:61-78` location/employment patterns**
  for *extracting the value* (after a contradiction is suspected) — regex is
  fine here as long as the *contradiction-suspect* signal is itself
  LLM-confirmed (which is recommended above as part of triage).
- **`src/conversation-compactor.ts:isPreservable`** — checks `msg.role`
  enum. Trivially correct.
- **`src/context-manager.ts`** — pure token estimation, no semantic
  classification. No regex involved.

---

## 3. Hybrid candidates (regex pre-filter → LLM confirm)

The shape that should be the *default* for everything in section 1 except
1.5 (auto-extract identity), 1.8 (compaction), 1.9 (triage), where regex
should be removed:

- **Action-claim hallucination (1.1)** — regex shape match → LLM disambiguate.
- **Approval/creation hallucination (1.4)** — same machinery as 1.1.
- **Conversational follow-up (1.2)** — regex catches obvious acks ("ok",
  "thanks") → LLM for medium-length cases.
- **Emotion detection (1.6)** — regex pre-filter "any emotion signal at all"
  → LLM for class assignment.
- **Vulnerability detection (1.7)** — regex catches obvious-yes high-severity
  (self-harm, immediate-family-death) → LLM for everything else.
- **Memory-curate regex (1.10)** — regex stays as cheap skip; LLM is the
  classifier when regex misses.

The pattern is: **regex provides cheap "definitely yes" or "definitely no"
verdicts; LLM gets the "maybe" middle.** This is also exactly what
`src/routing/router.ts` already does.

---

## 4. Architectural pattern — `classifyWithLLM`

The codebase already has `src/llm-dispatch.ts` (which gives us
single-shot completions across providers) and two reference implementations
(`src/routing/llm-classifier.ts`, `src/memory/curate-classifier.ts`).

The pattern those two share — system prompt template, JSON parse, timeout,
fallback to null — should be extracted once.

**Proposed file:** `src/classifiers/classify-with-llm.ts`

**Signature:**
```ts
export interface ClassifyOptions<T> {
  /** Logical name for telemetry / env-disable. e.g. "follow-up", "claim-verify". */
  category: string;
  /** Full system prompt. Must instruct the model to reply in `responseSchema` shape. */
  systemPrompt: string;
  /** User-side payload — usually the message + relevant context. */
  userPrompt: string;
  /** Parser: turn raw model text into T or null on shape mismatch. */
  parse: (raw: string) => T | null;
  /** Hard upper bound (ms). Default 2000. */
  timeoutMs?: number;
  /** Provider hint — defaults to dispatch's auto-pick (Haiku via OAuth, then OpenAI). */
  provider?: "anthropic" | "openai" | "ollama" | "auto";
  /** Model — defaults per provider (Haiku 4.5 / gpt-4o-mini / llama3:8b). */
  model?: string;
  /** Disable via env var — caller's choice of name. */
  envDisableVar?: string;
}

export async function classifyWithLLM<T>(opts: ClassifyOptions<T>): Promise<T | null>;
```

**~30-line implementation sketch:**
```ts
import { dispatch } from "../llm-dispatch.js";
import { createLogger } from "../logger.js";

export async function classifyWithLLM<T>(opts: ClassifyOptions<T>): Promise<T | null> {
  const logger = createLogger(`classifier.${opts.category}`);
  if (opts.envDisableVar && process.env[opts.envDisableVar] === "0") return null;

  const timeout = opts.timeoutMs ?? 2000;
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeout);
  try {
    const raw = await dispatch({
      prompt: `${opts.systemPrompt}\n\n---\n\n${opts.userPrompt}`,
      provider: opts.provider ?? "auto",
      anthropicModel: opts.model,
      openaiModel: opts.model,
      ollamaModel: opts.model,
      temperature: 0,
      maxTokens: 200,
      timeoutMs: timeout,
    });
    if (!raw) return null;
    const parsed = opts.parse(raw);
    if (!parsed) {
      logger.warn(`[${opts.category}] parse failed: "${raw.slice(0, 200)}"`);
      return null;
    }
    return parsed;
  } catch (e) {
    logger.warn(`[${opts.category}] failed: ${(e as Error).message}`);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** Convenience: yes/no classifier. Returns null on failure → caller falls back. */
export async function classifyYesNo(category: string, systemPrompt: string, userPrompt: string): Promise<boolean | null> {
  return classifyWithLLM<boolean>({
    category, systemPrompt, userPrompt,
    parse: (raw) => {
      const m = raw.match(/^(YES|NO)\b/im);
      if (!m) return null;
      return m[1].toUpperCase() === "YES";
    },
  });
}
```

**Migration path:**

1. Land `classifyWithLLM` and a `classifyYesNo` convenience wrapper.
2. Refactor `routing/llm-classifier.ts` to use it (smaller file, same
   behavior — proves the abstraction).
3. Refactor `memory/curate-classifier.ts` to use it.
4. *Then* add new classifiers: `claimVerify`, `followupClassify`,
   `vulnerabilityClassify`, `extractIdentityFacts`, `summarizeForCompaction`.

Each new classifier becomes ~10-20 lines plus its prompt — not a fresh copy
of all the auth, timeout, provider-pick, parse-fallback boilerplate that
currently lives in two files and would otherwise live in 7.

---

## 5. Repercussions of the current state

**The bug from tonight:** middleware nudge text leaked into the chat
transcript because a stale-prefix string-match in
`src/providers/sanitize.ts:stripEphemeralMessages` was matching against the
*beginning* of an ephemeral nudge that happens to start with the same
prefix as a real assistant message. This is the regex-overuse pattern
biting in the cleanup pipeline: regex was the cheap way to say "is this an
ephemeral nudge", but the answer is genuinely semantic.

**Other bugs that are inevitable given the current pattern (some have
already fired, others haven't yet):**

1. **Agent renamed to "Done" / "Cool" / "Wait"** — `src/memory/auto-extract.ts:34`
   regex `^([A-Z][a-zA-Z]{1,15})(?:\.|!|\s*$)/` matches any short
   capitalized message. STOP_WORDS gates *some* of these, but it's an
   incomplete list. First time someone says "Hello." or "Welcome." the agent
   tries to rename itself. Has this fired? Worth checking
   `~/.lax/IDENTITY.md` history.

2. **"I noted that" forces a memory_save retry every time it appears in a
   recap** — `src/agent-guards.ts:148` adds `noted` to the memory-verb class.
   "I noted three things in the bash output" → unmatched-action-claim nudge
   fires → model gets pushed to call `memory_save` for what was just a recap.
   Wastes one full retry iteration per occurrence.

3. **Wrong project signals bleed when both projects use the same vocab** —
   `src/orchestrator/orchestrator.ts:95` 2-keyword threshold. When the user
   says "audit the kraken bot" and a prior signal mentions "audit the open
   memory project," the words `audit` + `project` overlap → kraken context
   shows up alongside open-memory context. Cross-project bleed, gates
   topical-relevance only at the lexical level.

4. **Sarcastic praise gets logged as positive emotion** —
   `src/emotional-memory.ts:207` matches `awesome` / `great` / `nice` even in
   "oh great, another timeout." Long-running emotional history skews toward
   "happy" because the user makes lots of frustrated jokes. Adaptation hints
   then get tone-wrong on the *next* turn that fires the `frustrated`
   pathway.

5. **Compaction loses constraints in the middle of long user messages** —
   `src/conversation-compactor.ts:77` slices to 200 chars. User typed a 4-line
   spec ("build X, do *NOT* use Y, must support Z") — gets truncated to
   "build X, do" before compaction fires. Model proceeds to use Y because
   the constraint is gone.

6. **Vulnerability tag attached to discussions of OTHERS** —
   `src/vulnerability-awareness.ts:73` matches `lost (my|a) (mom|dad|...)`
   but "my friend lost his mom" fires the same regex → user tagged with
   grief disclosure they never made. Sacred-memory pollution.

7. **"refactor" + "across multiple files" auto-delegates a one-line ask
   that mentions a directory** — `src/routing/regex-rules.ts:32`
   MULTI_FILE_CUE_RE matches `src/`. "what's in src/index.ts" (a one-line
   discovery question) trips the multi-file cue and possibly delegates if
   word count is borderline. The routing LLM-veto (router.ts:62) catches
   most of this — but it can fail open. (This is mitigated, not
   eliminated.)

8. **TOOL_ID_HALLUCINATION_RE matches commit hashes** —
   `src/agent-guards.ts:79` includes `[a-f0-9]{6,16}` in the union. The
   reply "I see the issue in commit a4b5c6d7" → "Job ID a4b5c6d7" semantic
   match → hallucination nudge fires on a legitimate diagnostic reply.
   Currently gated by needing "Job/Schedule/Mission/Task/Run" word to
   precede; but adjacent constructions ("here's the run with id a4b5c6d7")
   trip it.

---

## 6. Cost ceiling

Assumptions:
- Haiku 4.5 pricing (`claude-haiku-4-5`): ~$1/MTok input, ~$5/MTok output
- Sonnet 4.6 if quality required: ~$3/MTok input, ~$15/MTok output
- Average classifier call: 300 in + 30 out tokens ($0.00045 Haiku / $0.0014
  Sonnet)
- "Active" turn = single user → assistant exchange, ~50 turns/day for an
  active user

**Per-turn additional cost if ALL recommended hotspots converted (Haiku 4.5):**

| Hotspot | Fires on % of turns | Per-fire cost | Per-turn amortized |
|---|---|---|---|
| 1.1 action-claim verify | ~5% (regex pre-filter) | $0.0004 | $0.00002 |
| 1.2 follow-up classify | ~30% (≤ 12 words) | $0.0004 | $0.00012 |
| 1.3 topic-relevance batch | 100% | $0.0006 | $0.00060 |
| 1.4 approval/creation verify | ~3% | $0.0004 | $0.00001 |
| 1.5 identity extract | ~2% (gated by curate hit) | $0.0005 | $0.00001 |
| 1.6 emotion (gated) | ~25% | $0.0003 | $0.00008 |
| 1.7 vulnerability (gated) | ~2% | $0.0004 | $0.00001 |
| 1.8 compaction summary | ~1% (only when full) | $0.01 | $0.00010 |
| 1.9 triage batch | 100% | $0.0006 | $0.00060 |
| **Total per turn** | — | — | **~$0.00175** |

**Per 1000 turns:** ~$1.75 — **less than $2** for an entirely classifier-driven
context layer across an active week's worth of turns. Across 1000 turns the
single largest line item is *batched* topic-relevance + triage, both of
which replace ~10 per-turn regex passes.

**Latency budget:** all classifier calls can run in parallel with model-call
preparation (most fire *during* `prepare-request.ts`, before the main agent
call begins). The serial path adds ~0ms because the longest classifier
(800ms p99 for Haiku via OAuth) finishes well before the main model call's
network round-trip. The exceptions are:
- compaction (1.8) — adds latency only on the rare full-context turn
- action-claim verify (1.1) — runs *after* the main reply, on the way back
  to the user. Adds ~200ms to the visible response on the ~5% of turns
  where it fires. Acceptable for the false-positive elimination.

**If we use Sonnet 4.6 instead of Haiku 4.5:** multiply by ~3.3x → ~$5.78
per 1000 turns. Recommendation: **stick with Haiku 4.5 for these classifiers.**
The accuracy delta vs Sonnet is small for short-form yes/no and structured
JSON outputs, and Haiku's latency is meaningfully better. Reserve Sonnet for
the compaction *summary* call (1.8) where output quality matters more —
even there, it's $0.03 instead of $0.01 per compaction event.

---

## Net recommendation

Land the abstraction (section 4) first. Then in priority order:

1. **Compaction (1.8)** — single biggest user-visible fix, no current LLM
   path, replace truncation with summarization. Highest value-per-LOC.
2. **Topic-relevance batch (1.3)** — gates every memory module's output;
   one Haiku call per turn replaces N per-signal regex passes.
3. **Action-claim hybrid (1.1) + Approval/creation hybrid (1.4)** — share
   the same machinery; ship together. Eliminates the "wrong nudge leaks
   into chat" class of bugs.
4. **Identity extract (1.5)** — durable memory writes, highest dollar-per-bug.
5. **Follow-up classifier (1.2)** — fixes the medium-length 5-9 word case
   the orchestrator currently mis-handles.
6. **Vulnerability + Emotion (1.7, 1.6)** — lowest priority; both have
   working-fine-most-days regex tables, both improve with hybrid.

Total cost ceiling: <$2 per 1000 turns. Total added per-turn latency: ~0ms
on the steady state path, ~200ms on the small minority of turns that hit
the back-side LLM verifications. The math is pleasant.
