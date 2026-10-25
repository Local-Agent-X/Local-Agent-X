/**
 * A message that tells the agent to edit is never a blanket write ban.
 *
 * Aider's retry prompt reads "The tests are correct, don't try and change them.
 * Fix the code in phone_number.py to resolve the errors." On 2026-09-17 the
 * LLM confirm returned workspace-write for it; grok diagnosed the one-character
 * fix and every write, edit and edit_lines call was refused as "the user asked
 * you not to edit or write files". The confirm prompt already states the rule —
 * nothing enforced it.
 */
import { describe, it, expect } from "vitest";
import { extractConstraints } from "./extract.js";
import { directsAnEdit } from "./edit-directive.js";
import type { ConfirmedConstraints } from "./extract.js";

// The mistake the real confirm made, reproduced deterministically.
const bansWrites = async (): Promise<ConfirmedConstraints> => ({ prohibitions: ["workspace-write"], obligations: [] });
const offline = async (): Promise<null> => null;

const AIDER_RETRY = [
  "FAIL: test_pretty_print",
  "AssertionError: '(223) 456-7890' != '(223)-456-7890'",
  "",
  "####",
  "",
  "See the testing errors above.",
  "The tests are correct, don't try and change them.",
  "Fix the code in phone_number.py to resolve the errors.",
].join("\n");

describe("an edit directive vetoes a whole-workspace write ban", () => {
  it("the exact retry prompt that bricked the fix now leaves writes allowed", async () => {
    const ledger = await extractConstraints(AIDER_RETRY, bansWrites);
    expect(ledger.prohibitions).not.toContain("workspace-write");
  });

  it("covers the everyday phrasings of the same request", async () => {
    for (const msg of [
      "Fix the bug in auth.ts. Don't change the tests.",
      "Don't touch the tests, and fix the parser.",
      "Please update the README but don't modify the license.",
      "Don't change the public API; refactor the internals.",
    ]) {
      const ledger = await extractConstraints(msg, bansWrites);
      expect(ledger.prohibitions, msg).not.toContain("workspace-write");
    }
  });

  it("also applies when the LLM is down and the strong tier decides", async () => {
    const ledger = await extractConstraints("Fix the failing test. Don't change the fixtures.", offline);
    expect(ledger.prohibitions).not.toContain("workspace-write");
  });

  it("keeps other prohibitions the model returned", async () => {
    const both = async (): Promise<ConfirmedConstraints> => ({ prohibitions: ["workspace-write", "egress"], obligations: [] });
    const ledger = await extractConstraints("Fix the parser, but don't browse the web and don't change the tests.", both);
    expect(ledger.prohibitions).toEqual(["egress"]);
  });
});

describe("read-only said of named inputs is not a no-edit session", () => {
  // The task that lost its only write (2026-10-24): the local confirm model was
  // not loaded, so the deterministic tier decided.
  const SCHEDULING = [
    "Find a 1-hour meeting slot for Alice, Bob, and Carol.",
    "",
    "Output: Create `/app/meeting_scheduled.ics` with a 1-hour \"Team Planning Meeting\".",
    "",
    "Input Integrity:",
    "- Treat the provided calendar files as read-only. Do not modify",
    "  `/app/alice_calendar.ics`, `/app/bob_calendar.ics`, or `/app/carol_calendar.ics`.",
  ].join("\n");

  it("the scheduling task keeps its write on both tiers", async () => {
    expect((await extractConstraints(SCHEDULING, offline)).prohibitions).not.toContain("workspace-write");
    expect((await extractConstraints(SCHEDULING, bansWrites)).prohibitions).not.toContain("workspace-write");
  });

  it("covers the everyday phrasings of the same request", async () => {
    for (const msg of [
      "Treat the originals as read-only and write the cleaned rows to out.csv.",
      "The fixtures are read-only. Don't modify them; add a new test file instead.",
      "Keep data/raw as read-only. Create a summary in report.md.",
      "Task: fix the parser. Do not modify the vendored files, they are read-only.",
    ]) {
      for (const confirm of [offline, bansWrites]) {
        const ledger = await extractConstraints(msg, confirm);
        expect(ledger.prohibitions, msg).not.toContain("workspace-write");
      }
    }
  });

  it("read-only said of the work itself still bans writes", async () => {
    for (const msg of [
      "Treat this as read-only: don't modify anything, write nothing, just tell me what's wrong.",
      "This session is read-only. Don't change the code; add your notes to the reply.",
      "Treat everything as read-only and don't edit the code. Fix suggestions go in your answer.",
    ]) {
      const ledger = await extractConstraints(msg, bansWrites);
      expect(ledger.prohibitions, msg).toContain("workspace-write");
    }
  });
});

describe("a real no-edit session still gets its ban", () => {
  it("diagnose-only requests keep workspace-write", async () => {
    for (const msg of [
      "Don't change anything, just tell me why the build fails.",
      "Read-only please — look at parser.ts and don't touch the code.",
      "Don't edit any files. Tell me what you would fix.",
      "Don't do anything, just tell me what's wrong with the fix.",
    ]) {
      const ledger = await extractConstraints(msg, bansWrites);
      expect(ledger.prohibitions, msg).toContain("workspace-write");
    }
  });

  it("an edit verb that is not an instruction does not count", () => {
    expect(directsAnEdit("Don't change the config; I need to know what would fix it.")).toBe(false);
    expect(directsAnEdit("Change nothing yet.")).toBe(false);
    expect(directsAnEdit("Is this approach correct? Don't edit it.")).toBe(false);
  });
});
