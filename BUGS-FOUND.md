# Bugs found while writing test coverage

## 1. `listOps()` crashes on numeric `createdAt`/`startedAt` fields

**File:** `src/workers/op-store.ts:55`

**Symptom:** `TypeError: (b.startedAt || b.createdAt).localeCompare is not a function`

**Repro:** Run `listOps()` on a `~/.lax/operations` directory containing any `operation.json` whose `createdAt` (or `startedAt`) is a number rather than an ISO string. On my machine 4 such files exist (prefix `op_ap_*` — looks like autopilot writes them with epoch-ms timestamps), enough to take down `listOps()` for the entire pool.

**Why it bites:** `Op.createdAt` is typed `string` but at least one writer in the codebase persists it as a number. `listOps()` then calls `.localeCompare(...)` on the number and throws.

**Suggested fix (do NOT apply this round):** Either coerce with `String(b.startedAt || b.createdAt)` in the comparator, or normalize on read in `readOp()` (convert number → `new Date(n).toISOString()`), or fix the offending writer (look for autopilot op-creation code paths producing `op_ap_*` ids). Coercing in the comparator is the smallest, safest fix.

**Tests dropped because of this:** `test/op-store.test.ts` originally had a `listOps` describe block; it's been removed and a single defensive smoke test left so the suite isn't environment-fragile. Re-add the describe block once the bug is fixed.

## 2. `filterStreamDelta` close-marker doesn't reset the suppress flag

**File:** `src/anthropic-client/parse.ts:54-59` (the `alreadySuppressing` close-marker branch) — combined with `src/anthropic-client/stream-cli.ts:253-254` (the consumer).

**Symptom:** Once a tool-call block opens (a chunk containing `` ```json ``, `{"tool_calls"`, `<tool_use>`, `<function_calls>`, etc.), suppression latches ON for the rest of the stream. Text that arrives AFTER the closing fence/marker — `\`\`\``, `}\n`, `</tool_use>`, `</function_calls>` — is silently dropped instead of being re-emitted to the user.

**Repro:** Feed the streamer this delta sequence:
```
"Hello. ", "```json", '{"tool_calls":[{"name":"x","arguments":{}}]}', "```", " bye."
```
The user sees `"Hello. "` only. `" bye."` is dropped.

**Why it bites:** The close-marker branch returns `{ text: "" }` and omits `suppress`. The consumer in `stream-cli.ts` is shaped:

```ts
if (cleanDelta.suppress) { suppressing = true; }
else if (cleanDelta.text) { suppressing = false; yield ... }
```

An empty string is falsy in JS, so neither branch fires. `suppressing` stays `true` for every subsequent chunk, all of which return `{ text: "" }` (since they no longer contain a fresh open marker but `alreadySuppressing` is still true). Every later chunk hits the same close-marker check, returns `{ text: "" }`, and gets dropped.

**Suggested fix (do NOT apply this round):** The producer should signal end-of-suppression explicitly. Two options:
- (a) Have the close-marker branch return `{ text: "", suppress: false }` so the consumer's threading code sees the explicit reset.
- (b) Have the consumer treat `text === ""` as a separate signal (`else if (cleanDelta.text !== undefined) suppressing = false;`).

Option (a) is the smaller change and keeps the producer in charge of state. The `parse-streaming.test.ts` suite documents the current (buggy) behavior — once fixed, those `.toContain(" after")` / `.toContain(" bye.")` / `.toContain(" trailing")` / `.toContain(" resumed.")` / `.toContain(" done.")` assertions will need to flip from "captured the leak" back to "verifies the fix".

**Tests added that document the bug:** `test/parse-streaming.test.ts` — every test marked with `// documents BUG #2 in BUGS-FOUND.md`.

## 3. `EXPLICIT_NOTIFY_RE` doesn't match "let me know when X" (the most common form)

**File:** `src/workers/idle-nudge.ts:31`

**Symptom:** Users who ask "let me know when this is done" / "let me know once it ships" do NOT get the fast (1s) explicit-notify nudge — they wait the full 2-minute idle window.

**Why it bites:** The regex requires the verb to be followed immediately by `me|us` and then `when|once|after|...`:

```
/\b(tell|let|notify|ping|alert|message|update)\s+(me|us)\s+(when|once|after|as\s+soon\s+as|the\s+moment|right\s+when)\b/i
```

So `tell me when`, `notify me when`, `update me once`, etc. all match. But `let me know when` has a `know` between `me` and `when` — the most natural English phrasing falls through.

**Repro:** `markSessionExplicitNotify("s", "let me know when it's done")` followed by a `scheduleIdleNudge` returns the 2-min default delay instead of 1s.

**Suggested fix (do NOT apply this round):** Allow an optional `know` (or any verb-ish word) between `me|us` and the temporal trigger:

```
/\b(tell|let|notify|ping|alert|message|update)\s+(me|us)(\s+know)?\s+(when|once|after|as\s+soon\s+as|the\s+moment|right\s+when)\b/i
```

Or split into two alternations. The cleanest fix is the optional `(\s+know)?` group since "let X know when Y" is the common pattern.

**Tests added that document the gap:** `test/idle-nudge.test.ts` — `does NOT match 'let me know when'` and `does NOT match 'let me know once'` regression guards.
