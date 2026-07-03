// Regression guard for the run-lineage tree's FLOWING CONNECTOR LINES (the
// signature "energy between agents" cue) in public/css/app.css.
//
// A CSS-only visual feature can't have its *look* asserted headlessly (that
// needs eyes on the running app), but its behavioral INVARIANTS can — and those
// are exactly the parts a careless refactor drops silently:
//   1. the flow is GATED on an actively-working descendant (:has(.agent-feed-card.working))
//      — without the gate a finished tree animates forever, breaking the C8
//      "calm when done" contract;
//   2. a prefers-reduced-motion block FREEZES the animation — accessibility;
//   3. the keyframe + the positioned ::before connector actually exist.
// We parse the stylesheet text and assert these, mirroring how the other
// agent-feeds specs read a public/ source file (chat-agent-feeds-width.test.ts).
import { describe, it, expect, beforeAll } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
let css = "";

// Collapse whitespace so selector-list line breaks don't defeat substring checks.
const flat = (s: string) => s.replace(/\s+/g, " ");

beforeAll(() => {
  css = flat(readFileSync(join(here, "../public/css/app.css"), "utf8"));
});

describe("agent-feeds flowing connector lines (CSS invariants)", () => {
  it("declares the flow keyframe used to scroll the pulses down the rail", () => {
    expect(css).toContain("@keyframes agent-feed-flow");
  });

  it("has a positioned ::before connector on .agent-feed-children (the flow track)", () => {
    // The rail can only anchor a flowing overlay if the container is positioned
    // and the ::before is absolutely placed over its left edge.
    expect(css).toMatch(/\.agent-feed-children\{[^}]*position:relative/);
    expect(css).toMatch(/\.agent-feed-children::before\{[^}]*position:absolute/);
  });

  it("starts the flow line INVISIBLE (idle/finished subtree shows only the static rail)", () => {
    // opacity:0 in the base ::before is what keeps a calm tree calm.
    expect(css).toMatch(/\.agent-feed-children::before\{[^}]*opacity:0[;}]/);
    // The static rail itself is preserved as the default connector.
    expect(css).toMatch(/\.agent-feed-children\{[^}]*border-left:1px solid var\(--border\)/);
  });

  it("only animates when a descendant is actively working (calm-when-finished contract)", () => {
    // The animation MUST be gated behind :has(.agent-feed-card.working). If this
    // gate is ever removed, a fully-finished tree would flow forever — the exact
    // regression this test exists to catch.
    const animatedRule = /:has\(\.agent-feed-card\.working\)[^{]*\.agent-feed-children::before\s*(,[^{]*)?\{[^}]*animation:agent-feed-flow/;
    expect(css).toMatch(animatedRule);
    // Both the nested (under-each-other) and the fan-out (together) containers
    // are wired to the same live gate.
    expect(css).toContain(".agent-feed-branch:has(.agent-feed-card.working)");
    expect(css).toContain(".agent-feed-group:has(.agent-feed-card.working)");
  });

  it("does NOT put agent-feed-flow on the always-on base rule (no ungated animation)", () => {
    // Guard against a future edit that adds the animation to the plain ::before
    // BASE rule (which every branch would run, finished or not). The base rule is
    // uniquely the one that starts with content:''; the gated rule's selector list
    // also ends in `.agent-feed-children::before{`, so we must isolate the base
    // block rather than substring-match the selector.
    const baseRule = css.match(/\.agent-feed-children::before\{content:'';[^}]*\}/);
    expect(baseRule).not.toBeNull();
    expect(baseRule![0]).not.toContain("animation");
  });

  it("freezes the flow flat under prefers-reduced-motion (accessibility)", () => {
    expect(css).toContain("@media (prefers-reduced-motion:reduce)");
    // Inside that block the gated rule must set animation:none.
    const rmBlock = css.slice(css.indexOf("@media (prefers-reduced-motion:reduce)"));
    expect(rmBlock).toMatch(/:has\(\.agent-feed-card\.working\)[\s\S]*?animation:none/);
  });
});
