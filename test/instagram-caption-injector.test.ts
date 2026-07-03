import { describe, it, expect } from "vitest";
import { buildCaptionInjector } from "../src/protocols/packs/instagram.js";

// Assert that the injected browser JS is syntactically valid for captions that
// contain the characters real captions actually contain. Pre-fix, the caption
// was escaped with JSON.stringify(...).slice(1,-1) (double-quote-escaped only)
// and then embedded inside single-quoted literals, so any apostrophe produced a
// SyntaxError in the browser evaluate. new Function(...) parses without running.
function assertParses(code: string) {
  // eslint-disable-next-line no-new-func
  return () => new Function(code);
}

describe("buildCaptionInjector emits valid JS", () => {
  it("handles captions with an apostrophe", () => {
    const code = buildCaptionInjector("Don't miss it — see you there!");
    expect(assertParses(code)).not.toThrow();
    // The caption's apostrophe must survive as data, un-mangled, inside the
    // JSON string literal that the injector embeds.
    expect(code).toContain("Don't miss it");
  });

  it("handles captions with double quotes, backslashes and newlines", () => {
    const caption = 'She said "hi"\nPath: C:\\Users\nLine\'s end';
    const code = buildCaptionInjector(caption);
    expect(assertParses(code)).not.toThrow();
  });

  it("handles a plain caption", () => {
    const code = buildCaptionInjector("Clean caption\nSecond line");
    expect(assertParses(code)).not.toThrow();
  });
});
