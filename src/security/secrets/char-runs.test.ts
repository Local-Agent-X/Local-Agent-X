// The character-loop run finders replace regexes that overflowed V8's backtrack
// stack on multi-megabyte runs. Their contract is "exactly what the regex
// matched", so they are checked against the regex on random text built from
// the characters that decide run edges.
import { describe, it, expect } from "vitest";
import { hexWordRuns, isAnyBase64Char, isStdBase64Char, isUrlBase64Char, paddedClassRuns } from "./char-runs.js";

const ALPHABET = "aF09zZ_-+/=% .:\né";

function randomText(seed: number, length: number): string {
  let s = seed;
  let out = "";
  for (let i = 0; i < length; i++) {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    // Long same-class stretches make runs that cross the length thresholds.
    const c = ALPHABET[s % ALPHABET.length];
    out += (s >> 8) % 3 === 0 ? c : c.repeat(1 + ((s >> 12) % 24));
  }
  return out;
}

const viaRegex = (text: string, re: RegExp) => Array.from(text.matchAll(re), (m) => ({ run: m[0], index: m.index ?? 0 }));

describe("char-runs — the same runs the regexes found", () => {
  const cases: Array<[string, (t: string) => unknown, RegExp]> = [
    ["either base64 alphabet, 16+", (t) => paddedClassRuns(t, isAnyBase64Char, 16), /[A-Za-z0-9+/_-]{16,}={0,2}/g],
    ["standard base64, 40+", (t) => paddedClassRuns(t, isStdBase64Char, 40), /[A-Za-z0-9+/]{40,}={0,2}/g],
    ["base64url, 20+", (t) => paddedClassRuns(t, isUrlBase64Char, 20), /[A-Za-z0-9_-]{20,}={0,2}/g],
    ["hex word, 32+", (t) => hexWordRuns(t, 32), /\b[0-9a-fA-F]{32,}\b/g],
    ["hex word, 24+", (t) => hexWordRuns(t, 24), /\b[0-9a-fA-F]{24,}\b/g],
  ];

  for (const [name, find, re] of cases) {
    it(name, () => {
      for (let seed = 1; seed <= 2000; seed++) {
        const text = randomText(seed, 60);
        expect(find(text), `seed ${seed}: ${JSON.stringify(text)}`).toEqual(viaRegex(text, re));
      }
    });
  }

  it("a run of several megabytes is found without a stack overflow", () => {
    const text = "x".repeat(8 * 1024 * 1024) + "==";
    expect(paddedClassRuns(text, isAnyBase64Char, 16)).toEqual([{ run: text, index: 0 }]);
  });
});
