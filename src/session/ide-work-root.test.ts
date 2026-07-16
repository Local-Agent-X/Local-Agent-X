/**
 * IDE session work-root anchoring — the seam that keeps an App IDE turn's tool
 * defaults on the app it's editing.
 *
 * Regression (Jul 15 2026, `todo-app` IDE session): "Work in
 * workspace/apps/todo-app/" existed ONLY as a sentence in the chat prefix. The
 * server never learned the appId, no work root was registered, and glob's
 * no-`path` default (`sessionWorkRootOf(sessionId) ?? process.cwd()`) fell back
 * to the repo root. `**\/*.css` returned LAX's own public/css/app.css as the
 * first hit and the agent edited the platform's stylesheet, then reported
 * success. The app dir contained no CSS at all.
 *
 * The last case drives the REAL glob/grep search-base functions rather than
 * re-asserting the registry, because the registry was never the broken part —
 * the missing link from "which app is this turn for" to "where do tools look"
 * was. A test that only checked setSessionWorkRoot would have stayed green
 * through the entire live failure.
 */

import { describe, it, expect, afterEach, beforeAll, vi } from "vitest";
import { mkdtempSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { realpathSync } from "node:fs";

// A throwaway workspace — never the user's real one. Created before the mock
// factory runs, since vi.mock is hoisted above module scope.
const TMP_WS = realpathSync(mkdtempSync(join(tmpdir(), "lax-ide-workroot-")));

vi.mock("../config.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../config.js")>();
  return { ...actual, workspacePath: (...segs: string[]) => resolve(TMP_WS, ...segs) };
});

const { stampIdeWorkRoot, ideAppDir } = await import("./ide-work-root.js");
const { sessionWorkRootOf, clearSessionWorkRoot } = await import("../workspace/paths.js");
const { searchBase } = await import("../tools/glob-tool.js");

const SESSION = "ide-todo-app-test";
const APP_DIR = resolve(TMP_WS, "apps", "todo-app");

beforeAll(() => {
  mkdirSync(APP_DIR, { recursive: true });
});

afterEach(() => clearSessionWorkRoot(SESSION));

describe("ideAppDir", () => {
  it("maps a well-formed id to its workspace dir", () => {
    expect(ideAppDir("todo-app")).toBe(APP_DIR);
  });

  it.each([
    ["traversal", "../../etc"],
    ["absolute posix", "/etc/passwd"],
    ["absolute windows", "C:\\Windows"],
    ["backslash traversal", "..\\..\\secrets"],
    ["dotted", "todo.app"],
    ["empty", ""],
    ["non-string", 42],
  ])("refuses %s", (_label, bad) => {
    expect(ideAppDir(bad)).toBeNull();
  });
});

describe("stampIdeWorkRoot", () => {
  it("anchors the session to the app dir", () => {
    expect(stampIdeWorkRoot(SESSION, "todo-app")).toBe(APP_DIR);
    expect(sessionWorkRootOf(SESSION)).toBe(APP_DIR);
  });

  it("clears the anchor when a frame carries no appId — a session that leaves IDE mode must not keep it", () => {
    stampIdeWorkRoot(SESSION, "todo-app");
    expect(sessionWorkRootOf(SESSION)).toBe(APP_DIR);
    expect(stampIdeWorkRoot(SESSION, undefined)).toBeNull();
    expect(sessionWorkRootOf(SESSION)).toBeUndefined();
  });

  it("leaves the session unanchored for a traversal id rather than anchoring outside the workspace", () => {
    expect(stampIdeWorkRoot(SESSION, "../../..")).toBeNull();
    expect(sessionWorkRootOf(SESSION)).toBeUndefined();
  });

  it("does not anchor to an app dir that does not exist", () => {
    expect(stampIdeWorkRoot(SESSION, "no-such-app")).toBeNull();
    expect(sessionWorkRootOf(SESSION)).toBeUndefined();
  });

  it("re-stamping moves the anchor", () => {
    const other = resolve(TMP_WS, "apps", "other-app");
    mkdirSync(other, { recursive: true });
    stampIdeWorkRoot(SESSION, "todo-app");
    expect(stampIdeWorkRoot(SESSION, "other-app")).toBe(other);
    expect(sessionWorkRootOf(SESSION)).toBe(other);
  });
});

describe("cross-seam: the anchor reaches glob's default search base", () => {
  it("a no-path glob searches the app dir, not the repo root (the wrong-file edit)", () => {
    // Unanchored: the pre-fix behavior that found LAX's own public/css/app.css.
    expect(searchBase(undefined, SESSION)).toBe(process.cwd());

    stampIdeWorkRoot(SESSION, "todo-app");

    // Anchored: the same call now cannot see the repo at all.
    expect(searchBase(undefined, SESSION)).toBe(APP_DIR);
    expect(searchBase(undefined, SESSION)).not.toBe(process.cwd());
  });

  it("an explicit relative glob path still anchors to the app dir", () => {
    stampIdeWorkRoot(SESSION, "todo-app");
    expect(searchBase("css", SESSION)).toBe(resolve(APP_DIR, "css"));
  });
});
