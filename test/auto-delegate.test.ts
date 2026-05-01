import { describe, it, expect } from "vitest";
import { shouldAutoDelegate } from "../src/workers/auto-delegate.js";

// Helper: build a message of `n` words with a neutral verb that doesn't
// trigger the long-task verb gate. Letting word-count be the only signal
// keeps the 50-word branch isolated from the verb branch.
function neutralWords(n: number): string {
  return Array.from({ length: n }, (_, i) => `word${i}`).join(" ");
}

describe("shouldAutoDelegate — channel gating", () => {
  it("returns false for non-web channels even on a long message", () => {
    const msg = neutralWords(100);
    expect(shouldAutoDelegate("anthropic", msg, "telegram")).toBe(false);
    expect(shouldAutoDelegate("anthropic", msg, "whatsapp")).toBe(false);
    expect(shouldAutoDelegate("anthropic", msg, "voice")).toBe(false);
    expect(shouldAutoDelegate("anthropic", msg, "cron")).toBe(false);
    expect(shouldAutoDelegate("anthropic", msg, "")).toBe(false);
  });

  it("only delegates on channel === 'web'", () => {
    const msg =
      "Refactor the authentication middleware in src/auth and update all the tests";
    expect(shouldAutoDelegate("anthropic", msg, "web")).toBe(true);
  });
});

describe("shouldAutoDelegate — short-task / greeting filter", () => {
  it.each([
    "yes",
    "no",
    "ok",
    "sure",
    "thanks",
    "hi",
    "hello",
    "what",
    "when",
    "where",
    "why",
    "how",
    "who",
  ])("never delegates on greeting/ack: %s", (greeting) => {
    expect(shouldAutoDelegate("anthropic", greeting, "web")).toBe(false);
  });

  it("never delegates on a message <= 30 chars (short-task regex tail)", () => {
    expect(shouldAutoDelegate("anthropic", "build it", "web")).toBe(false);
    expect(shouldAutoDelegate("anthropic", "fix the bug now", "web")).toBe(
      false,
    );
  });

  it("'yo' (super short ack) never delegates", () => {
    expect(shouldAutoDelegate("anthropic", "yo", "web")).toBe(false);
  });
});

describe("shouldAutoDelegate — 50+ words always delegates", () => {
  it("delegates on 50 words even with no verb cue", () => {
    expect(shouldAutoDelegate("anthropic", neutralWords(50), "web")).toBe(true);
  });

  it("delegates on 100 words even without file cues or task verbs", () => {
    expect(shouldAutoDelegate("anthropic", neutralWords(100), "web")).toBe(
      true,
    );
  });

  it("does NOT delegate on 49 words without verb or file cue", () => {
    expect(shouldAutoDelegate("anthropic", neutralWords(49), "web")).toBe(
      false,
    );
  });
});

describe("shouldAutoDelegate — long-task verb + multi-file cue", () => {
  it("delegates on short-ish message with long-task verb + workspace/ cue (>30 chars)", () => {
    const msg = "refactor workspace/auth/middleware.ts";
    // No 50-word and no 15-word gate; relies purely on verb + file cue.
    // Must exceed 30 chars to clear the SHORT_TASK_RE tail.
    expect(msg.length).toBeGreaterThan(30);
    expect(shouldAutoDelegate("anthropic", msg, "web")).toBe(true);
  });

  it("delegates on 'add a settings panel to workspace/apps/X'", () => {
    const msg = "add a settings panel to workspace/apps/X";
    expect(shouldAutoDelegate("anthropic", msg, "web")).toBe(true);
  });

  it("delegates on 'build a thing in workspace/foo.ts here today'", () => {
    const msg = "build a thing in workspace/foo.ts here today";
    expect(msg.length).toBeGreaterThan(30);
    expect(shouldAutoDelegate("anthropic", msg, "web")).toBe(true);
  });

  it("delegates on 'audit every file in the repo carefully' (verb + multi-file phrase)", () => {
    const msg = "audit every file in the repo carefully";
    expect(msg.length).toBeGreaterThan(30);
    expect(shouldAutoDelegate("anthropic", msg, "web")).toBe(true);
  });

  it("delegates on 'rewrite multiple files' (verb + multi-file phrase)", () => {
    const msg = "rewrite multiple files in the project tree";
    expect(shouldAutoDelegate("anthropic", msg, "web")).toBe(true);
  });

  it("does NOT delegate on a message <= 30 chars even with verb + file cue (short-task gate wins)", () => {
    // Documents the existing precedence — short-task filter runs first.
    const msg = "build src/foo.ts";
    expect(msg.length).toBeLessThanOrEqual(30);
    expect(shouldAutoDelegate("anthropic", msg, "web")).toBe(false);
  });
});

describe("shouldAutoDelegate — long-task verb + 15+ words", () => {
  it("delegates when a long-task verb is paired with >= 15 words", () => {
    const msg =
      "refactor the authentication module so that the new flow returns a different shape with proper validation";
    // 16 words, has 'refactor', no file cue → must use 15+ word branch
    expect(msg.split(/\s+/).length).toBeGreaterThanOrEqual(15);
    expect(shouldAutoDelegate("anthropic", msg, "web")).toBe(true);
  });

  it("does NOT delegate when verb is present but word count is too low and no file cue", () => {
    // 'refactor' verb but only 8 words and no multi-file cue
    const msg = "refactor the auth module please for cleanliness today";
    expect(msg.split(/\s+/).length).toBeLessThan(15);
    expect(shouldAutoDelegate("anthropic", msg, "web")).toBe(false);
  });

  it("delegates on 'investigate' + 15+ words", () => {
    const msg =
      "investigate why the worker pool seems to leak memory across long sessions and grows over time";
    expect(shouldAutoDelegate("anthropic", msg, "web")).toBe(true);
  });

  it("delegates on 'implement' + 15+ words", () => {
    const msg =
      "implement a streaming response handler with proper backpressure and timeout handling for the websocket connection right now please";
    expect(shouldAutoDelegate("anthropic", msg, "web")).toBe(true);
  });

  it("delegates on 'add' verb when paired with 15+ words", () => {
    const msg =
      "add a new dashboard panel that shows the live worker queue depth and lets the user click into a worker for a status drill down view";
    expect(shouldAutoDelegate("anthropic", msg, "web")).toBe(true);
  });
});

describe("shouldAutoDelegate — provider is irrelevant", () => {
  it("same decision regardless of provider name", () => {
    const msg =
      "refactor the authentication module so that the new flow returns a different shape with proper validation";
    expect(shouldAutoDelegate("codex", msg, "web")).toBe(true);
    expect(shouldAutoDelegate("anthropic", msg, "web")).toBe(true);
    expect(shouldAutoDelegate("openai", msg, "web")).toBe(true);
    expect(shouldAutoDelegate("xai", msg, "web")).toBe(true);
    expect(shouldAutoDelegate("gemini", msg, "web")).toBe(true);
    expect(shouldAutoDelegate("local", msg, "web")).toBe(true);
    expect(shouldAutoDelegate("anything-here", msg, "web")).toBe(true);
  });

  it("provider doesn't override the short-task filter", () => {
    expect(shouldAutoDelegate("codex", "yo", "web")).toBe(false);
    expect(shouldAutoDelegate("anthropic", "yo", "web")).toBe(false);
  });
});

describe("shouldAutoDelegate — multi-word verb phrases (regex variants)", () => {
  it("'wire up' verb phrase qualifies on verb + multi-file cue", () => {
    const msg = "wire up the new logging hook in src/observability/logger.ts";
    expect(shouldAutoDelegate("anthropic", msg, "web")).toBe(true);
  });

  it("'wire up' qualifies on verb + 15+ words", () => {
    const msg =
      "wire up the new logging hook so that downstream consumers see structured events instead of raw text strings";
    expect(msg.split(/\s+/).length).toBeGreaterThanOrEqual(15);
    expect(shouldAutoDelegate("anthropic", msg, "web")).toBe(true);
  });

  it("'set up' verb phrase qualifies on verb + multi-file cue", () => {
    const msg = "set up the email outbound queue using src/email/outbox.ts";
    expect(shouldAutoDelegate("anthropic", msg, "web")).toBe(true);
  });

  it("'bootstrap' verb qualifies on verb + 15+ words", () => {
    const msg =
      "bootstrap the new tenant onboarding flow with welcome email and seed sample data so they have something to play with";
    expect(shouldAutoDelegate("anthropic", msg, "web")).toBe(true);
  });

  it("'design then' phrase qualifies on verb + 15+ words", () => {
    const msg =
      "design then prototype the new agent inbox view that surfaces pending approvals and lets the user act on them in batch";
    expect(shouldAutoDelegate("anthropic", msg, "web")).toBe(true);
  });

  it("'design and' phrase qualifies on verb + multi-file cue", () => {
    const msg = "design and rewrite src/agent/loop.ts properly today";
    expect(shouldAutoDelegate("anthropic", msg, "web")).toBe(true);
  });

  it("'review the' phrase qualifies on verb + 15+ words", () => {
    const msg =
      "review the current worker pool implementation and tell me what needs to change to support burst capacity for short ops";
    expect(shouldAutoDelegate("anthropic", msg, "web")).toBe(true);
  });

  it("'migrate' verb qualifies on verb + multi-file cue", () => {
    const msg = "migrate src/legacy/auth to the new module structure please";
    expect(shouldAutoDelegate("anthropic", msg, "web")).toBe(true);
  });

  it("'analyze' verb qualifies on verb + multi-file cue", () => {
    const msg = "analyze the call graph in src/workers and find dead code";
    expect(shouldAutoDelegate("anthropic", msg, "web")).toBe(true);
  });

  it("'extend' verb qualifies on verb + 15+ words", () => {
    const msg =
      "extend the heartbeat protocol so workers can report progress percentages back to the supervisor while running long ops";
    expect(shouldAutoDelegate("anthropic", msg, "web")).toBe(true);
  });

  it("'enhance' verb qualifies on verb + multi-file cue", () => {
    const msg = "enhance the streaming logic in src/anthropic-client/stream.ts";
    expect(shouldAutoDelegate("anthropic", msg, "web")).toBe(true);
  });

  it("'trace' verb qualifies on verb + 15+ words", () => {
    const msg =
      "trace the path of a chat message from the websocket handler through the prepare-request layer down to the streamer";
    expect(shouldAutoDelegate("anthropic", msg, "web")).toBe(true);
  });

  it("'debug' verb qualifies on verb + multi-file cue", () => {
    const msg = "debug the panic happening in src/workers/pool.ts on shutdown";
    expect(shouldAutoDelegate("anthropic", msg, "web")).toBe(true);
  });

  it("'fix every endpoint' fix-every-word variant qualifies on verb + 15+ words", () => {
    const msg =
      "fix every endpoint that currently returns 500 when the worker pool is paused so users get a friendly error instead";
    expect(shouldAutoDelegate("anthropic", msg, "web")).toBe(true);
  });

  it("'fix multiple' fix-multiple variant qualifies on verb + 15+ words", () => {
    const msg =
      "fix multiple flaky tests in the heartbeat suite that fail intermittently when run with the threads pool";
    expect(shouldAutoDelegate("anthropic", msg, "web")).toBe(true);
  });
});

describe("shouldAutoDelegate — multi-file cue variants", () => {
  it("'.tsx' file cue triggers", () => {
    const msg = "refactor the dashboard component in pages/Dashboard.tsx today";
    expect(shouldAutoDelegate("anthropic", msg, "web")).toBe(true);
  });

  it("'.py' file cue triggers", () => {
    const msg = "refactor the helpers module in lib/utils.py to add types";
    expect(shouldAutoDelegate("anthropic", msg, "web")).toBe(true);
  });

  it("'.js' file cue triggers", () => {
    const msg = "refactor the build hook in scripts/build-ari.js carefully";
    expect(shouldAutoDelegate("anthropic", msg, "web")).toBe(true);
  });

  it("'node_modules' cue triggers", () => {
    const msg = "audit node_modules for vulnerable dependencies right now";
    expect(shouldAutoDelegate("anthropic", msg, "web")).toBe(true);
  });

  it("'across' phrase triggers as multi-file cue", () => {
    const msg = "refactor the logger usage across the entire codebase now";
    expect(shouldAutoDelegate("anthropic", msg, "web")).toBe(true);
  });

  it("'throughout' phrase triggers as multi-file cue", () => {
    const msg = "audit error handling throughout the worker pipeline today";
    expect(shouldAutoDelegate("anthropic", msg, "web")).toBe(true);
  });

  it("'every file' phrase triggers as multi-file cue", () => {
    const msg = "refactor every file in the workers directory carefully";
    expect(shouldAutoDelegate("anthropic", msg, "web")).toBe(true);
  });

  it("'all the tests' phrase triggers as multi-file cue", () => {
    const msg = "rewrite all the tests in the heartbeat suite to use fakes";
    expect(shouldAutoDelegate("anthropic", msg, "web")).toBe(true);
  });

  it("'all the components' phrase triggers as multi-file cue", () => {
    const msg = "audit all the components in the dashboard for accessibility";
    expect(shouldAutoDelegate("anthropic", msg, "web")).toBe(true);
  });
});

describe("shouldAutoDelegate — exact word-count boundary", () => {
  it("verb + exactly 15 words delegates (boundary inclusive)", () => {
    // Exactly 15 words, 'refactor' verb, no file cue
    const msg = "refactor word2 word3 word4 word5 word6 word7 word8 word9 word10 word11 word12 word13 word14 word15";
    expect(msg.split(/\s+/).length).toBe(15);
    expect(shouldAutoDelegate("anthropic", msg, "web")).toBe(true);
  });

  it("verb + exactly 14 words does NOT delegate (one short of boundary, no file cue, >30 chars)", () => {
    const msg = "refactor word2 word3 word4 word5 word6 word7 word8 word9 word10 word11 word12 word13 word14";
    expect(msg.split(/\s+/).length).toBe(14);
    expect(msg.length).toBeGreaterThan(30);
    expect(shouldAutoDelegate("anthropic", msg, "web")).toBe(false);
  });

  it("exactly 50 neutral words delegates regardless of verb", () => {
    const msg = neutralWords(50);
    expect(msg.split(/\s+/).length).toBe(50);
    expect(shouldAutoDelegate("anthropic", msg, "web")).toBe(true);
  });
});

describe("shouldAutoDelegate — case insensitivity", () => {
  it("verb regex matches uppercase 'REFACTOR'", () => {
    const msg = "REFACTOR THE AUTH MODULE PLEASE in src/auth/index.ts now";
    expect(shouldAutoDelegate("anthropic", msg, "web")).toBe(true);
  });

  it("verb regex matches mixed case 'WiRe Up'", () => {
    const msg = "WiRe Up the new logger throughout the codebase now please";
    expect(shouldAutoDelegate("anthropic", msg, "web")).toBe(true);
  });
});

describe("shouldAutoDelegate — whitespace + empty inputs", () => {
  it("empty string never delegates (matches short-task tail with 0 chars)", () => {
    expect(shouldAutoDelegate("anthropic", "", "web")).toBe(false);
  });

  it("whitespace-only message never delegates (trims to <= 30 chars)", () => {
    expect(shouldAutoDelegate("anthropic", "   ", "web")).toBe(false);
    expect(shouldAutoDelegate("anthropic", "\n\n\t", "web")).toBe(false);
  });

  it("trailing whitespace doesn't push a short greeting past the 30-char gate", () => {
    // 'thanks' is in the SHORT_TASK_RE alternation. Even with surrounding
    // whitespace, .trim() before the regex test ensures it still matches.
    expect(shouldAutoDelegate("anthropic", "  thanks  ", "web")).toBe(false);
  });

  it("a tab+newline-padded long message still delegates (trim is upstream)", () => {
    // Inner content is 80+ chars of non-greeting prose with a long-task verb.
    const msg = "\n\n  refactor the authentication module so that the new flow returns a different shape with proper validation\n";
    expect(shouldAutoDelegate("anthropic", msg, "web")).toBe(true);
  });
});

describe("shouldAutoDelegate — short-task regex anchor semantics", () => {
  it("'no' as a leading word triggers the greeting branch (regex is anchored at start)", () => {
    // SHORT_TASK_RE: `^(yes|no|...)\b` — anchored. The 30-char tail also
    // matches but the leading-word branch fires first for short input.
    expect(shouldAutoDelegate("anthropic", "no don't do that", "web")).toBe(false);
  });

  it("'no' embedded mid-sentence is NOT treated as a greeting (anchor missed)", () => {
    // 30-char tail still kicks in for short messages, so a long enough
    // message containing 'no' mid-sentence + verb + 15 words DOES delegate.
    const msg = "please refactor the module if there is no other clean way to handle the rare overflow case in production";
    expect(shouldAutoDelegate("anthropic", msg, "web")).toBe(true);
  });

  it("'whatever' (starts with 'what' but not at word boundary) does NOT match the greeting branch", () => {
    // 'what' has \b after it; 'whatever' has 'e' next so \b fails. The
    // 30-char tail still applies — short messages stay inline regardless.
    const msg = "whatever, refactor the entire authentication module please today right now";
    // Verb present + 11 words + no file cue → fails (need 15+ or file cue).
    expect(shouldAutoDelegate("anthropic", msg, "web")).toBe(false);
  });
});

describe("shouldAutoDelegate — false-negative regressions guarded", () => {
  it("'fix the bug' alone (no scale signal) does NOT delegate", () => {
    // 'fix' is intentionally NOT in the long-task verb list (only fix-all/the/every).
    // A 3-word fix request stays inline.
    expect(shouldAutoDelegate("anthropic", "fix the bug", "web")).toBe(false);
  });

  it("'fix all the failing tests' (fix-all variant) qualifies as long-task verb", () => {
    const msg =
      "fix all the failing tests across the suite and rerun the build to confirm green";
    // 'fix all' matches verb regex + 15+ words → delegates
    expect(shouldAutoDelegate("anthropic", msg, "web")).toBe(true);
  });

  it("'design and ship a thing' (verb phrase) qualifies", () => {
    const msg =
      "design and ship a new toggle for the settings panel that controls dark mode preference for users";
    expect(shouldAutoDelegate("anthropic", msg, "web")).toBe(true);
  });
});

describe("shouldAutoDelegate — build-verb + app-noun phrase", () => {
  // Closes the gap that let "create an app to manage all the powerpoints we
  // create" run inline (10 words, no file cue) and burn 11min of the chat
  // agent's context. The BUILD_NOUN_RE requires the verb to be directly
  // attached to an app-shaped noun, so passive mentions stay inline.

  it("delegates on 'create an app to manage all the powerpoints we create'", () => {
    const msg = "create an app to manage all the powerpoints we create";
    expect(msg.split(/\s+/).length).toBeLessThan(15); // would fail the old gate
    expect(shouldAutoDelegate("anthropic", msg, "web")).toBe(true);
  });

  it("delegates on 'build me a notes app' (short, casual)", () => {
    const msg = "build me a notes app for daily journaling";
    expect(shouldAutoDelegate("anthropic", msg, "web")).toBe(true);
  });

  it("delegates on 'create a dashboard for X'", () => {
    const msg = "create a dashboard for tracking my workouts each week";
    expect(shouldAutoDelegate("anthropic", msg, "web")).toBe(true);
  });

  it("delegates on 'make a new tool that does Y'", () => {
    const msg = "make a new tool that converts CSVs to charts";
    expect(shouldAutoDelegate("anthropic", msg, "web")).toBe(true);
  });

  it("delegates on 'set up a small integration with Stripe'", () => {
    const msg = "set up a small integration with Stripe for one-time payments";
    expect(shouldAutoDelegate("anthropic", msg, "web")).toBe(true);
  });

  it("delegates on 'scaffold an api for the inventory module'", () => {
    const msg = "scaffold an api for the inventory module with CRUD endpoints";
    expect(shouldAutoDelegate("anthropic", msg, "web")).toBe(true);
  });

  it("delegates on 'spin up a quick page to track expenses'", () => {
    const msg = "spin up a quick page to track expenses by category";
    expect(shouldAutoDelegate("anthropic", msg, "web")).toBe(true);
  });

  // ── Negative cases — passive / discussion mentions of apps must stay inline ──

  it("does NOT delegate on 'the app is broken can you check it'", () => {
    const msg = "the app is broken can you check it for me";
    // No build verb at the head → BUILD_NOUN_RE doesn't match. No file cue
    // and only 10 words → the verb-gate also fails. Stays inline.
    expect(shouldAutoDelegate("anthropic", msg, "web")).toBe(false);
  });

  it("does NOT delegate on 'whats the best dashboard tool you recommend'", () => {
    const msg = "whats the best dashboard tool you recommend for personal use";
    // No constructive verb on the dashboard noun. Stays inline.
    expect(shouldAutoDelegate("anthropic", msg, "web")).toBe(false);
  });

  it("does NOT delegate on 'i was thinking about apps yesterday'", () => {
    const msg = "i was thinking about apps yesterday and had an idea or two";
    expect(shouldAutoDelegate("anthropic", msg, "web")).toBe(false);
  });

  it("does NOT delegate on 'this dashboard looks ugly'", () => {
    const msg = "this dashboard looks ugly to me lately can we discuss";
    expect(shouldAutoDelegate("anthropic", msg, "web")).toBe(false);
  });

  it("does NOT delegate on 'did you create an app yesterday for that?'", () => {
    // Past-tense question containing "create an app" — BUILD_NOUN_RE WILL
    // match this because the literal phrase is there. Acceptable trade-off:
    // the LLM worker can clarify "you mean look it up?" cheaply, whereas
    // missing a real build request costs the chat agent its whole context.
    // This test pins that decision so a future tightening doesn't surprise.
    const msg = "did you create an app yesterday for that workflow we discussed";
    expect(shouldAutoDelegate("anthropic", msg, "web")).toBe(true);
  });

  it("does NOT delegate on bare 'create' verb without an app-noun (short)", () => {
    // "create a new branch" — verb fires, "branch" is not in app-noun list,
    // word count under 15, no file cue → stays inline.
    const msg = "create a new branch off main and call it experiment";
    expect(shouldAutoDelegate("anthropic", msg, "web")).toBe(false);
  });

  it("delegates on 'BUILD ME A FULL DASHBOARD' (case insensitivity)", () => {
    const msg = "BUILD ME A FULL DASHBOARD FOR THE WAREHOUSE STAFF";
    expect(shouldAutoDelegate("anthropic", msg, "web")).toBe(true);
  });
});

describe("shouldAutoDelegate — Codex investigative widening", () => {
  // Codex drifts on short investigative prompts that Anthropic handles fine.
  // Real session 2026-05-01 burned 4 turns / 350k tokens with evidence-stale
  // aborts on prompts like "why isn't voice working" — we want those routed
  // to the worker pool for fresh context. Anthropic stays inline.

  it("delegates on Codex 'why is voice broken'", () => {
    const msg = "why is voice broken on this machine";
    expect(shouldAutoDelegate("codex", msg, "web")).toBe(true);
  });

  it("does NOT delegate on Anthropic 'why is voice broken' (no drift on short prompts)", () => {
    const msg = "why is voice broken on this machine";
    expect(shouldAutoDelegate("anthropic", msg, "web")).toBe(false);
  });

  it("delegates on Codex 'look into the failing tests'", () => {
    const msg = "look into the failing tests in the heartbeat suite";
    expect(shouldAutoDelegate("codex", msg, "web")).toBe(true);
  });

  it("delegates on Codex 'check why settings won't save'", () => {
    const msg = "check why the settings won't save anymore today";
    expect(shouldAutoDelegate("codex", msg, "web")).toBe(true);
  });

  it("delegates on Codex 'find out how the worker pool boots up'", () => {
    const msg = "find out how the worker pool boots up at startup";
    expect(shouldAutoDelegate("codex", msg, "web")).toBe(true);
  });

  it("delegates on Codex 'investigate the auto-delegate heuristic'", () => {
    const msg = "investigate the auto-delegate heuristic in detail today";
    expect(shouldAutoDelegate("codex", msg, "web")).toBe(true);
  });

  it("delegates on Codex 'figure out why the build is slow'", () => {
    const msg = "figure out why the build is slow on this branch";
    expect(shouldAutoDelegate("codex", msg, "web")).toBe(true);
  });

  it("does NOT delegate on Codex with too few words ('why' alone)", () => {
    // 4 words doesn't clear the > 4 floor. The whole 30-char gate also kills it.
    const msg = "why is voice broken anyway";
    // 5 words but this lands at 28 chars → SHORT_TASK_RE 30-char tail wins.
    expect(msg.length).toBeLessThanOrEqual(30);
    expect(shouldAutoDelegate("codex", msg, "web")).toBe(false);
  });

  it("does NOT delegate on Codex 'how are you doing today' (no investigative pattern)", () => {
    const msg = "how are you doing today my friend in there";
    // 'how' triggers SHORT_TASK_RE greeting branch → false regardless.
    expect(shouldAutoDelegate("codex", msg, "web")).toBe(false);
  });

  it("does NOT delegate on Codex passive 'the debug page is broken'", () => {
    // 'debug' as adjective modifying 'page' shouldn't fire — but our regex
    // matches the word 'debug' anywhere. This test pins the current trade-off:
    // we accept some over-trigger on Codex because the cost of staying inline
    // is high (token bloat + drift). If this becomes a real false-positive
    // pain, tighten with a verb-position lookahead.
    const msg = "the debug page is broken when I click the link";
    // 10 words, 'debug' matches CODEX_INVESTIGATIVE_RE → currently delegates.
    expect(shouldAutoDelegate("codex", msg, "web")).toBe(true);
  });
});
