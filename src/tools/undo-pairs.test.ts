import { describe, expect, it } from "vitest";
import { TOOL_RISK } from "../autonomy/risk.js";
import { TOOLS } from "../tool-registry.js";
import { IRREVERSIBLE, UNDO_PAIRS, unpairedDestructive, withUndoCounterparts } from "./undo-pairs.js";

const destructive = Object.entries(TOOL_RISK).filter(([, risk]) => risk === "destructive").map(([name]) => name).sort();

describe("undo pairing covers every destructive tool", () => {
  it("every destructive-risk tool is paired or declared irreversible — never unclassified", () => {
    const unclassified = destructive.filter((n) => !UNDO_PAIRS[n] && !IRREVERSIBLE.has(n));
    expect(unclassified, "add each to UNDO_PAIRS (with its counterpart) or IRREVERSIBLE (on purpose) in tools/undo-pairs.ts").toEqual([]);
  });

  it("no tool is in both lists, and every pair target is a registered tool", () => {
    const both = Object.keys(UNDO_PAIRS).filter((n) => IRREVERSIBLE.has(n));
    expect(both).toEqual([]);
    const missing = Object.entries(UNDO_PAIRS).filter(([, pair]) => !TOOLS[pair]).map(([n, pair]) => `${n} → ${pair}`);
    expect(missing, "pair targets must be real registered tools").toEqual([]);
    const notDestructive = [...Object.keys(UNDO_PAIRS), ...IRREVERSIBLE].filter((n) => TOOL_RISK[n] !== "destructive");
    expect(notDestructive, "only destructive-risk tools belong in these lists").toEqual([]);
  });
});

describe("withUndoCounterparts", () => {
  const t = (name: string) => ({ name });
  const catalog = ["read", "delete_file", "restore_file", "process_kill", "process_start", "glob"].map(t);

  it("adds the missing pair from the catalog and leaves everything else alone", () => {
    const set = withUndoCounterparts([t("read"), t("delete_file")], catalog);
    expect(set.map((x) => x.name)).toEqual(["read", "delete_file", "restore_file"]);
    expect(unpairedDestructive(set)).toEqual([]);
  });

  it("is a no-op when the pair is already present or nothing destructive is in the set", () => {
    expect(withUndoCounterparts([t("delete_file"), t("restore_file")], catalog).map((x) => x.name)).toEqual(["delete_file", "restore_file"]);
    expect(withUndoCounterparts([t("read"), t("glob")], catalog).map((x) => x.name)).toEqual(["read", "glob"]);
  });

  it("reports the EXP-7 failure shape", () => {
    expect(unpairedDestructive([t("read"), t("delete_file")])).toEqual(["delete_file"]);
  });
});
