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
