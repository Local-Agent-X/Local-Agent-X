/**
 * The confirm judges the gated cues; it cannot add a class no cue refers to.
 *
 * muse, wordy, 2026-09-17: the retry prompt's "don't try and change them" came
 * back from the confirm as a `shell` ban, and every bash call in the retry was
 * refused as "the user asked you not to run shell commands".
 */
import { describe, it, expect } from "vitest";
import { extractConstraints, type ConfirmedConstraints } from "./extract.js";
import { supportedByCues } from "./cue-support.js";

const confirms = (...prohibitions: ConfirmedConstraints["prohibitions"]) =>
  async (): Promise<ConfirmedConstraints> => ({ prohibitions, obligations: [] });

const AIDER_RETRY = [
  "AssertionError: 'unknown operation' != 'syntax error'",
  "",
  "####",
  "",
  "See the testing errors above.",
  "The tests are correct, don't try and change them.",
  "Fix the code in wordy.py to resolve the errors.",
].join("\n");

describe("a confirmed class needs a cue that can mean it", () => {
  it("the retry prompt that blocked bash no longer yields a shell ban", async () => {
    const ledger = await extractConstraints(AIDER_RETRY, confirms("shell", "workspace-write"));
    expect(ledger.prohibitions).toEqual([]);
  });

  it("keeps a class its cue names", async () => {
    expect((await extractConstraints("Don't run any commands, just read the code.", confirms("shell"))).prohibitions).toContain("shell");
    expect((await extractConstraints("Don't browse the web for this.", confirms("egress"))).prohibitions).toEqual(["egress"]);
    expect((await extractConstraints("Don't read my .env file.", confirms("sensitive-read"))).prohibitions).toEqual(["sensitive-read"]);
    expect((await extractConstraints("Don't edit anything, I only want an explanation.", confirms("workspace-write"))).prohibitions).toEqual(["workspace-write"]);
  });

  it("lets a do-nothing cue carry any class", async () => {
    const ledger = await extractConstraints("Hands off — just tell me what is wrong.", confirms("workspace-write", "shell"));
    expect(ledger.prohibitions).toEqual(["workspace-write", "shell"]);
  });

  it("drops only the unsupported class from a mixed verdict", () => {
    expect(supportedByCues(["shell", "egress"], ["don't run the build"])).toEqual(["shell"]);
    expect(supportedByCues(["egress"], ["don't try and change"])).toEqual([]);
  });
});
