// Regression tests for the "fresh-install auth token is empty forever" bug.
//
// On a fresh install (or after -DeleteData uninstall), Electron starts up
// before the LAX server has written ~/.lax/config.json, so the very first
// loadLAXConfig() call finds no file and falls back to DEFAULTS
// ({ port: 7007, authToken: "" }). If that empty-token result gets cached,
// every subsequent getLAXConfig() returns the same stale empty token — the
// tokenized URL loaded into the main window is `?token=` (empty) — and every
// backend request 401s until the user manually clears state.
//
// The fix: loadLAXConfig() reports whether the result came from disk or is a
// placeholder; getLAXConfig() only caches real reads.

import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("electron", () => ({
  app: { getPath: () => "/tmp/fake-electron-userdata" },
}));

// Mock the fs module so we can flip file-exists state between subtests
// without touching the user's real home directory.
let _fileExists = false;
let _fileContents = "";
vi.mock("fs", () => ({
  existsSync: (_p: string) => _fileExists,
  readFileSync: (_p: string, _enc: string) => _fileContents,
  statSync: (_p: string) => ({ uid: 0, mode: 0o600 }),
}));

// After the mocks are declared, import the module under test.
import { getLAXConfig, reloadLAXConfig, loadLAXConfig } from "./config";

// Clear the module-scope cache between tests. We can't reach into `cached`
// directly, but reloadLAXConfig() with a missing file leaves cached=null,
// which is what we want.
beforeEach(() => {
  _fileExists = false;
  _fileContents = "";
  reloadLAXConfig();
});

describe("loadLAXConfig — fromFile signal", () => {
  it("reports fromFile:false when the config file doesn't exist", () => {
    _fileExists = false;
    const result = loadLAXConfig();
    expect(result.fromFile).toBe(false);
    expect(result.config.authToken).toBe(""); // placeholder
    expect(result.config.port).toBe(7007);
  });

  it("reports fromFile:true when the config file exists and parses", () => {
    _fileExists = true;
    _fileContents = JSON.stringify({ port: 7007, authToken: "real-token-abc" });
    const result = loadLAXConfig();
    expect(result.fromFile).toBe(true);
    expect(result.config.authToken).toBe("real-token-abc");
  });

  it("reports fromFile:false when the config file is corrupt (JSON parse fails)", () => {
    _fileExists = true;
    _fileContents = "{ not-json";
    const result = loadLAXConfig();
    expect(result.fromFile).toBe(false);
    expect(result.config.authToken).toBe("");
  });
});

describe("getLAXConfig — does not cache placeholders (fresh-install regression)", () => {
  it("returns the real token when the config appears between calls", () => {
    // First call: file doesn't exist yet (simulates Electron booting before
    // the LAX server has written its config on a fresh install).
    _fileExists = false;
    const first = getLAXConfig();
    expect(first.authToken).toBe("");

    // Server has now written the file.
    _fileExists = true;
    _fileContents = JSON.stringify({ port: 7007, authToken: "new-real-token" });

    // Second call: MUST see the real token, not the cached empty one.
    // Before the fix this returned "" forever, which is the bug.
    const second = getLAXConfig();
    expect(second.authToken).toBe("new-real-token");
  });

  it("does cache once a real file read succeeds (no perf regression)", () => {
    _fileExists = true;
    _fileContents = JSON.stringify({ port: 7007, authToken: "cached-token" });
    const first = getLAXConfig();
    expect(first.authToken).toBe("cached-token");

    // Simulate the file being deleted/rotated. The cached token must
    // survive — we only recache on reload, otherwise a transient file
    // rename during the LAX server's atomic rotate could clobber a valid
    // in-memory token with an empty one.
    _fileExists = false;
    const second = getLAXConfig();
    expect(second.authToken).toBe("cached-token");
  });
});

describe("reloadLAXConfig", () => {
  it("resets the cache when the file is missing", () => {
    _fileExists = true;
    _fileContents = JSON.stringify({ port: 7007, authToken: "old-token" });
    getLAXConfig(); // seeds cache

    _fileExists = false;
    reloadLAXConfig(); // file gone — must un-cache

    _fileExists = true;
    _fileContents = JSON.stringify({ port: 7007, authToken: "even-newer-token" });
    expect(getLAXConfig().authToken).toBe("even-newer-token");
  });

  it("updates the cache to the current file contents", () => {
    _fileExists = true;
    _fileContents = JSON.stringify({ port: 7007, authToken: "v1" });
    expect(getLAXConfig().authToken).toBe("v1");

    _fileContents = JSON.stringify({ port: 7007, authToken: "v2" });
    reloadLAXConfig();
    expect(getLAXConfig().authToken).toBe("v2");
  });
});
