// A row's message id says where the row came from, and one module says how to
// read it. Nine readers skipped the chat history an op's log opens with by
// writing the "hist-" prefix out themselves; the writer was a tenth copy.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { SEEDED_HISTORY_PREFIX, USER_MESSAGE_PREFIX, isSeededHistoryRow, isUserMessageRow } from "./message-ids.js";

describe("message ids", () => {
  it("tells a replayed history row and the turn's user message from what the op produced", () => {
    expect(isSeededHistoryRow(`${SEEDED_HISTORY_PREFIX}op_1-0-0-ab12cd`)).toBe(true);
    expect(isUserMessageRow(`${USER_MESSAGE_PREFIX}op_1-3-0-ab12cd`)).toBe(true);
    for (const produced of ["msg_01ABC", "op_1-3-1", "history-of-rome", ""]) {
      expect(isSeededHistoryRow(produced), produced).toBe(false);
      expect(isUserMessageRow(produced), produced).toBe(false);
    }
  });

  it("no other module spells the history prefix in a startsWith", () => {
    const sources = (dir: string): string[] =>
      readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
        e.isDirectory() ? sources(join(dir, e.name)) : /(?<!\.test)\.ts$/.test(e.name) ? [join(dir, e.name)] : [],
      );
    const own = sources("src")
      .filter((file) => /startsWith\(["'`]hist-/.test(readFileSync(file, "utf-8")))
      .map((file) => file.replace(/\\/g, "/"));
    expect(own).toEqual([]);
  });
});
