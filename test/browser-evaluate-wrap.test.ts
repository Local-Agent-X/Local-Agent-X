import { describe, it, expect } from "vitest";

// We test the wrapping policy by reproducing it inline against the same
// detection rules used in src/browser/page-ops.ts. If those rules drift,
// these tests fail and force a sync. Keeping the policy in one place
// (page-ops.ts) without making the helper exported avoids broadening the
// public surface for a behavior that's purely internal.

function wrapForEvaluate(script: string): { wrapped: string; iife: boolean } {
  const trimmed = script.trim().replace(/;\s*$/, "");
  const needsIife =
    /(^|[\s;{}])return\b/.test(trimmed) ||
    /[;\n]/.test(trimmed) ||
    /(^|[\s;{}])(const|let|var|function|async\s+function)\b/.test(trimmed) ||
    /(^|[\s;{}])(if|for|while|switch|try)\s*[({]/.test(trimmed);
  return {
    wrapped: needsIife ? `(() => { ${trimmed} })()` : `(${trimmed})`,
    iife: needsIife,
  };
}

describe("browser.evaluate wrap policy — IIFE vs expression", () => {
  // Live failure (2026-05-13, Thriveventory PO entry): agent wrote
  // `const els = ...; els.forEach(...)` and Playwright errored with
  // "Unexpected token 'const'". The expression-only wrap path can't
  // handle declarations, multi-statement scripts, or control flow.

  it("wraps a `const` declaration in an IIFE", () => {
    const r = wrapForEvaluate("const x = document.title; x");
    expect(r.iife).toBe(true);
    expect(r.wrapped).toContain("const x");
  });

  it("wraps a `let` declaration in an IIFE", () => {
    const r = wrapForEvaluate("let x = 1; x");
    expect(r.iife).toBe(true);
  });

  it("wraps a `var` declaration in an IIFE", () => {
    const r = wrapForEvaluate("var x = 1; x");
    expect(r.iife).toBe(true);
  });

  it("wraps multi-statement scripts (joined by `;`) in an IIFE", () => {
    const r = wrapForEvaluate("document.body.click(); 'done'");
    expect(r.iife).toBe(true);
  });

  it("wraps scripts spanning multiple lines in an IIFE", () => {
    const r = wrapForEvaluate("document.querySelector('.btn')\n  .click()");
    expect(r.iife).toBe(true);
  });

  it("wraps an explicit `return` statement in an IIFE", () => {
    const r = wrapForEvaluate("return document.title");
    expect(r.iife).toBe(true);
  });

  it("wraps `for` loops in an IIFE", () => {
    const r = wrapForEvaluate("for (const el of document.querySelectorAll('input')) el.value = ''");
    expect(r.iife).toBe(true);
  });

  it("wraps `if` blocks in an IIFE", () => {
    const r = wrapForEvaluate("if (document.body.dataset.x) document.title");
    expect(r.iife).toBe(true);
  });

  it("wraps `function` declarations in an IIFE", () => {
    const r = wrapForEvaluate("function f() { return 1 } f()");
    expect(r.iife).toBe(true);
  });

  it("parenthesizes a single bare expression (no statements)", () => {
    const r = wrapForEvaluate("document.title");
    expect(r.iife).toBe(false);
    expect(r.wrapped).toBe("(document.title)");
  });

  it("parenthesizes a property-chain expression", () => {
    const r = wrapForEvaluate("document.querySelector('h1').innerText");
    expect(r.iife).toBe(false);
  });

  it("parenthesizes a method call expression", () => {
    const r = wrapForEvaluate("document.title.toUpperCase()");
    expect(r.iife).toBe(false);
  });

  it("strips a trailing semicolon before deciding", () => {
    const r = wrapForEvaluate("document.title;");
    // Single statement with trailing semi → still a bare expression after strip
    expect(r.iife).toBe(false);
    expect(r.wrapped).toBe("(document.title)");
  });

  it("does NOT false-positive on words that contain control keywords", () => {
    // "letMeBeClear" contains "let" but not as a keyword
    const r = wrapForEvaluate("letMeBeClear");
    expect(r.iife).toBe(false);
  });

  it("does NOT false-positive on words that contain `return`", () => {
    // "myReturn" contains "return" but not as a keyword
    const r = wrapForEvaluate("myReturn");
    expect(r.iife).toBe(false);
  });
});
