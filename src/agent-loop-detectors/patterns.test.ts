import { describe, it, expect } from "vitest";
import { isWaitingOnUser, isExploratoryBashCommand } from "./patterns.js";

describe("isWaitingOnUser — clarifying / choice questions", () => {
  // Regression: "I want to start a company" → agent asked "What do you want
  // first?" and the uncommitted-turn nudge overrode it into build_app,
  // shipping two unwanted websites. A clarifying question must suppress the
  // "commit work now" nudges.
  it("treats an offer-menu clarifying question as waiting-on-user", () => {
    const reply =
      "LIVE = Live Integrated Violent Event training. I can flesh out the " +
      "brand, build the website, or create a curriculum. What do you want first?";
    expect(isWaitingOnUser(reply)).toBe(true);
  });

  it.each([
    "Which of these would you like me to tackle?",
    "Which option do you prefer?",
    "Would you like me to start with the landing page?",
    "Want me to also spin up a business plan doc?",
    "Should I build the site or the curriculum first?",
    "What would you like to prioritize?",
  ])("recognizes %j", (text) => {
    expect(isWaitingOnUser(text)).toBe(true);
  });

  // Must NOT over-suppress: a turn that promises action with no question
  // should still allow the nudges to fire.
  it.each([
    "I'll build the landing page now.",
    "Done — the dashboard is live.",
    "Reading the routes directory to find the handler.",
  ])("does not match committed/action text %j", (text) => {
    expect(isWaitingOnUser(text)).toBe(false);
  });

  // Pre-existing behavior still holds.
  it("still matches explicit asks for input", () => {
    expect(isWaitingOnUser("Send me the invoice and I'll proceed.")).toBe(true);
    expect(isWaitingOnUser("Let me know when you're ready.")).toBe(true);
  });
});

describe("isExploratoryBashCommand", () => {
  it.each([
    "cat src/index.ts",
    "ls -la",
    "grep -rn foo src/",
    "find . -name '*.ts'",
    "head -50 file && tail -20 file",
    "grep foo file | sort | uniq",
    "pwd",
  ])("treats read-only command %j as exploratory", (cmd) => {
    expect(isExploratoryBashCommand(cmd)).toBe(true);
  });

  it.each([
    "sleep 70 && date",       // the regression: one committing segment poisons the whole command
    "npm run build",
    "git commit -m wip",
    "cat template > out.txt",  // redirect mutates the filesystem
    "grep foo file | tee log",
    "node script.js",
    "",
  ])("treats committing/unknown command %j as non-exploratory", (cmd) => {
    expect(isExploratoryBashCommand(cmd)).toBe(false);
  });
});
