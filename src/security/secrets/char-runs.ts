/**
 * Runs of one character class in a text, found by walking character codes.
 *
 * The scanner's passes look for base64, hex and percent runs in text the model
 * wrote, and that text can be one multi-megabyte run (a base64 image). A regex
 * like /[A-Za-z0-9+/]{40,}/g keeps a backtrack entry per character of its
 * greedy loop, so V8 threw RangeError on a ~7 MB run before any verdict was
 * produced. A plain loop has no such limit and is linear.
 */

export const isDigit = (c: number): boolean => c >= 48 && c <= 57;
const isAlpha = (c: number) => (c >= 65 && c <= 90) || (c >= 97 && c <= 122);
export const isHexDigit = (c: number): boolean => isDigit(c) || (c >= 65 && c <= 70) || (c >= 97 && c <= 102);
/** JavaScript's `\w`: what `\b` turns on. */
export const isWordChar = (c: number): boolean => isAlpha(c) || isDigit(c) || c === 95;
/** [A-Za-z0-9+/] */
export const isStdBase64Char = (c: number): boolean => isAlpha(c) || isDigit(c) || c === 43 || c === 47;
/** [A-Za-z0-9_-] */
export const isUrlBase64Char = (c: number): boolean => isWordChar(c) || c === 45;
/** [A-Za-z0-9+/_-]: either base64 alphabet. */
export const isAnyBase64Char = (c: number): boolean => isStdBase64Char(c) || c === 95 || c === 45;

const EQUALS = 61;

export interface CharRun {
  run: string;
  index: number;
}

/** Maximal runs of `inRun` characters, as [start, end) pairs. */
export function maximalRuns(text: string, inRun: (c: number) => boolean): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  let start = -1;
  for (let i = 0; i <= text.length; i++) {
    const member = i < text.length && inRun(text.charCodeAt(i));
    if (member && start < 0) start = i;
    else if (!member && start >= 0) {
      out.push([start, i]);
      start = -1;
    }
  }
  return out;
}

/** What /[class]{min,}={0,2}/g matches: each maximal run of the class at least
 *  `min` long, with up to two `=` of padding after it. */
export function paddedClassRuns(text: string, inClass: (c: number) => boolean, min: number): CharRun[] {
  const out: CharRun[] = [];
  for (const [start, end] of maximalRuns(text, inClass)) {
    if (end - start < min) continue;
    let stop = end;
    while (stop < end + 2 && text.charCodeAt(stop) === EQUALS) stop++;
    out.push({ run: text.slice(start, stop), index: start });
  }
  return out;
}

/** What /\b[0-9a-fA-F]{min,}\b/g matches: a whole word made only of hex digits. */
export function hexWordRuns(text: string, min: number): CharRun[] {
  const out: CharRun[] = [];
  for (const [start, end] of maximalRuns(text, isWordChar)) {
    if (end - start < min) continue;
    let hex = true;
    for (let i = start; i < end && hex; i++) hex = isHexDigit(text.charCodeAt(i));
    if (hex) out.push({ run: text.slice(start, end), index: start });
  }
  return out;
}
