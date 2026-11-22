// A message's topics are memory's content words (memory/text-utils.ts) and the
// pairs of neighbours among them. The topics had a stop-word list and an
// ASCII-only split of their own: a message in Russian had no topics at all,
// and "don't" was dropped by a list entry no split could ever produce.
import { describe, expect, it } from "vitest";
import { extractTopics } from "./text-utils.js";

describe("extractTopics", () => {
  it("lists each content word once, then each pair of neighbours", () => {
    expect(extractTopics("Please review the invoice, the invoice total is wrong")).toEqual([
      "review", "invoice", "total", "wrong",
      "review invoice", "invoice invoice", "invoice total", "total wrong",
    ]);
  });

  it("finds the topics of a message in any script", () => {
    expect(extractTopics("Одалис живёт в Лиссабоне")).toEqual([
      "одалис", "живёт", "лиссабоне", "одалис живёт", "живёт лиссабоне",
    ]);
  });

  it("gives a greeting no topics, and never more than ten", () => {
    expect(extractTopics("hey, thanks, okay!")).toEqual([]);
    expect(extractTopics("alpha bravo charlie delta echo foxtrot golf hotel india juliet kilo lima")).toHaveLength(10);
  });
});
