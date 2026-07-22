/**
 * computeAuthWallPrefix — detection heuristic + prefix wording.
 *
 * The wording tests exist because of a real regression: the old prefix said
 * "STOP. ... Do NOT call more browser actions", which the model read as a
 * GLOBAL halt — asked to open 3 sites, it hit a login wall on site 1 and
 * never opened the other 2. The prefix must be page-scoped: block bypass
 * attempts on THIS page while explicitly telling the model to continue any
 * other pending work.
 */
import { describe, it, expect } from "vitest";
import { appendPostActionSnapshot, computeAuthWallPrefix } from "./shared.js";
import { ObservationRegistry, type BrowserObservation } from "../../browser/observation.js";

/** A snapshot that trips the detector: password field near the top with adjacent auth cues. */
const AUTH_WALL_SNAPSHOT = [
  "[1]<heading>Welcome back</heading>",
  '[2]<input type=email name=email placeholder="Email">',
  "[3]<input type=password name=password>",
  "[4]<button>Sign in</button>",
].join("\n");

describe("computeAuthWallPrefix — detection heuristic (unchanged)", () => {
  it("fires on a primary login form (password near top + adjacent auth cues)", () => {
    expect(computeAuthWallPrefix(AUTH_WALL_SNAPSHOT)).not.toBe("");
  });

  it("does not fire when there is no password field", () => {
    const snap = "[1]<heading>News</heading>\n[2]<link>Sign in</link>";
    expect(computeAuthWallPrefix(snap)).toBe("");
  });

  it("does not fire when the password field is below the fold (line > 60)", () => {
    const filler = Array.from({ length: 70 }, (_, i) => `[${i + 1}]<text>row ${i + 1}</text>`);
    const snap = [...filler, "[71]<input type=password>", "[72]<button>Sign in</button>"].join("\n");
    expect(computeAuthWallPrefix(snap)).toBe("");
  });

  it("does not fire on a stray password field with no adjacent auth signals", () => {
    const snap = "[1]<text>hello</text>\n[2]<input type=password>\n[3]<text>world</text>";
    expect(computeAuthWallPrefix(snap)).toBe("");
  });
});

describe("computeAuthWallPrefix — prefix wording is page-scoped", () => {
  const prefix = computeAuthWallPrefix(AUTH_WALL_SNAPSHOT);

  it("starts with the [AUTH-WALL DETECTED] marker (provider-riders matches on startsWith)", () => {
    expect(prefix.startsWith("[AUTH-WALL DETECTED]")).toBe(true);
  });

  it("does not issue a global halt on browser actions", () => {
    expect(prefix).not.toMatch(/do not call (any )?more browser actions/i);
  });

  it('contains no bare standalone "STOP."', () => {
    expect(prefix).not.toMatch(/(^|\s)STOP\.(\s|$)/);
  });

  it("explicitly instructs continuing other pending work", () => {
    expect(prefix).toMatch(/does not block other work/i);
    expect(prefix).toMatch(/continue with those now/i);
  });

  it("still forbids bypassing the wall or typing credentials", () => {
    expect(prefix).toMatch(/do not attempt to bypass/i);
    expect(prefix).toMatch(/do not type credentials yourself/i);
  });

  it("tells the model to report which page is waiting on the user's login", () => {
    expect(prefix).toMatch(/tell the user which page is waiting on their login/i);
  });
});

describe("appendPostActionSnapshot — a degraded observation stays loud in the tool result", () => {
  it("the extraction-failure notice and screenshot steer survive the external-content wrap", async () => {
    const obs: BrowserObservation = {
      url: "https://example.com/a",
      title: "Example",
      isInitial: false,
      added: [], removed: [], changed: [],
      offscreenCount: 0, totalCount: 0, currentRefs: [],
      obstructions: [], dialogs: [], crossOriginIframes: [],
      degraded: [{ op: "elements", reason: "Execution context was destroyed" }],
    };
    const manager = {
      snapshot: async () => ObservationRegistry.format(obs),
      getCurrentUrl: () => "https://example.com/a",
    };
    const out = await appendPostActionSnapshot(manager, "Filled [3]");

    expect(out).toContain("Filled [3]");
    expect(out).toContain("== OBSERVATION DEGRADED");
    expect(out).toContain("Element extraction FAILED: Execution context was destroyed");
    expect(out).toContain('browser({action:"screenshot"})');
    // Never the silent shape the bug produced: an unexplained clean page.
    expect(out).not.toContain("Page unchanged since last observation");
    expect(out).not.toContain("interactive elements:");
  });
});
