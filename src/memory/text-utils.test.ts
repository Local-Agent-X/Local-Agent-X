// The words of a text have one home, text-utils.ts: the split rule, the
// stop-word lists and jaccardSimilarity. Search, MMR, consolidation, topics,
// the atlas and the signal gate all read them, so their edge cases are pinned
// here for every caller.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { STOP_WORDS, contentWords, jaccardSimilarity, splitWords, tokenizeBasic, tokenizeStrict } from "./text-utils.js";
import { extractKeywords } from "./utils.js";

describe("jaccardSimilarity", () => {
  it("is intersection over union, for sets and plain iterables alike", () => {
    expect(jaccardSimilarity(new Set(["a", "b", "c"]), new Set(["b", "c", "d"]))).toBe(0.5);
    expect(jaccardSimilarity(["a", "b", "b"], ["b", "a"])).toBe(1);
  });

  it("calls two empty inputs identical and one empty input disjoint", () => {
    expect(jaccardSimilarity([], [])).toBe(1);
    expect(jaccardSimilarity(["a"], [])).toBe(0);
    expect(jaccardSimilarity([], new Set(["a"]))).toBe(0);
  });
});

describe("splitWords", () => {
  it("splits on anything that is not a letter, mark or digit, and lowercases", () => {
    expect(splitWords("Send_Email: re-run v2, don't!")).toEqual(["send", "email", "re", "run", "v2", "don", "t"]);
    expect(splitWords("  ...  ")).toEqual([]);
  });

  it("keeps a word whole when its vowels are combining marks", () => {
    expect(splitWords("मुझे हिंदी पसंद है")).toEqual(["मुझे", "हिंदी", "पसंद", "है"]);
    expect(splitWords("أُحِبُّ القهوة")).toEqual(["أُحِبُّ", "القهوة"]);
    expect(splitWords("ฉันชอบกาแฟ ร้อน")).toEqual(["ฉันชอบกาแฟ", "ร้อน"]);
  });
});

describe("tokenizeStrict", () => {
  const words = (text: string) => [...tokenizeStrict(text)];

  it("keeps an English sentence's content words, dropping stopwords and short words", () => {
    expect(words("The user's cousin keeps it at slip 14 in Port-Avila")).toEqual(["user", "cousin", "keeps", "slip", "port", "avila"]);
  });

  it("keeps words in every script, not only ASCII", () => {
    expect(words("Одалис живёт в Лиссабоне")).toEqual(["одалис", "живёт", "лиссабоне"]);
    expect(words("Le café près d'Évora")).toEqual(["café", "près", "évora"]);
  });

  it("keeps a two-character word in a syllabic script", () => {
    expect(words("서울 에 살아요")).toEqual(["서울", "에", "살아요"]);
    expect(words("東京")).toEqual(["東京"]);
  });

  it("keeps the words a claim can turn on, which contentWords drops", () => {
    expect(words("still only need more")).toEqual(["still", "only", "need", "more"]);
    expect(contentWords("still only need more")).toEqual([]);
  });
});

describe("tokenizeBasic", () => {
  it("keeps stop words, and words in every script", () => {
    expect(tokenizeBasic("The cat and the hat")).toEqual(["the", "cat", "and", "the", "hat"]);
    expect(tokenizeBasic("Одалис живёт в Лиссабоне")).toEqual(["одалис", "живёт", "лиссабоне"]);
    expect(tokenizeBasic("서울 에 살아요")).toEqual(["서울", "에", "살아요"]);
  });
});

describe("contentWords", () => {
  it("drops function words, filler and the halves of a contraction, in order and with repeats", () => {
    expect(contentWords("Hey, thanks! I didn't know the invoice was due, please pay the invoice")).toEqual(["invoice", "due", "pay", "invoice"]);
  });

  it("takes the shortest word a caller wants, and any length in a syllabic script", () => {
    expect(contentWords("ai pr review")).toEqual(["review"]);
    expect(contentWords("ai pr review", 2)).toEqual(["ai", "pr", "review"]);
    expect(contentWords("deploy the api to 東京", 4)).toEqual(["deploy", "東京"]);
  });

  it("never keeps a word tokenizeStrict drops", () => {
    const text = "the user is under the impression that she has been over this with them";
    const strict = tokenizeStrict(text);
    for (const w of contentWords(text)) expect(strict.has(w), w).toBe(true);
  });

  it("leaves a name and two real words searchable", () => {
    for (const w of ["don", "won", "ill"]) expect(STOP_WORDS.has(w), w).toBe(false);
  });
});

describe("extractKeywords — a message's search keywords", () => {
  it("keeps two-letter words and drops filler", () => {
    expect(extractKeywords("ok so what do you know about the AI PR?")).toEqual(["ai", "pr"]);
  });

  it("keeps every word of a message whose script writes vowels as marks", () => {
    // Was ["पस"]: one syllable, and under the two-keyword floor for recall.
    expect(extractKeywords("मुझे हिंदी पसंद है")).toEqual(["मुझे", "हिंदी", "पसंद", "है"]);
  });
});

// A stop-word list of its own is how these drifted apart: four lists, each
// missing words the others had. A list that is a different job says so in its
// name (a slug that is not an entity, a fragment that echoes the agent).
describe("memory, cognition and the orchestrator share the stop words", () => {
  const sources = (dir: string): string[] =>
    readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
      e.isDirectory() ? sources(join(dir, e.name)) : /(?<!\.test)\.ts$/.test(e.name) ? [join(dir, e.name)] : [],
    );

  it("no module declares a list named STOP_WORDS or STOPWORDS but text-utils.ts", () => {
    const own = ["src/memory", "src/cognition", "src/orchestrator"].flatMap(sources)
      .filter((file) => /\bSTOP_?WORDS\s*=/.test(readFileSync(file, "utf-8")))
      .map((file) => file.replace(/\\/g, "/"));
    expect(own).toEqual(["src/memory/text-utils.ts"]);
  });
});
