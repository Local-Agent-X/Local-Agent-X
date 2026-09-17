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
import { extractConstraints, directsAnEdit } from "./extract.js";
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
