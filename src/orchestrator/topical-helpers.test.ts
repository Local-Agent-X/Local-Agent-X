// The keyword gate on session signals reads memory's content words
// (memory/text-utils.ts). Its own split was ASCII-only: a message in Russian
// or Korean had no keywords, so no signal could overlap it and every one was
// dropped whenever the gate ran on keywords.
import { describe, expect, it } from "vitest";
import { signalTopicallyRelevant, topicalKeywords } from "./topical-helpers.js";

describe("topicalKeywords", () => {
  it("is the content words of four letters or more", () => {
    expect([...topicalKeywords("I really wanted the new logo for Baddies-and-Daddies, dont you?")]).toEqual(["logo", "baddies", "daddies"]);
  });

  it("keeps the words of a message in another script, short ones in a syllabic script", () => {
    expect([...topicalKeywords("Одалис переехала в Лиссабон")]).toEqual(["одалис", "переехала", "лиссабон"]);
    expect([...topicalKeywords("서울 에서 로고 작업")]).toEqual(["서울", "에서", "로고", "작업"]);
  });
});

describe("signalTopicallyRelevant", () => {
  it("keeps a signal sharing two keywords with the message, in any script", () => {
    const words = topicalKeywords("Одалис переехала в Лиссабон");
    expect(signalTopicallyRelevant(words, "Одалис ищет квартиру: Лиссабон, центр")).toBe(true);
    expect(signalTopicallyRelevant(words, "Одалис купила велосипед")).toBe(false);
  });
});
