/**
 * Unit tests for MCP config placeholder expansion.
 *
 * Pins three behaviors that gate Phase 1 of the "MCP first-class" plan:
 *
 *   1. `${HOME}` / `${USERPROFILE}` / `~/` resolve to the real home dir at
 *      LOAD time. A single synced ~/.lax/mcp.json works on every machine
 *      without per-host forks (the original failure: a hardcoded
 *      C:\Users\manri\Documents path that worked on the home machine and
 *      ENOENT'd on every other one).
 *
 *   2. `${secret:NAME}` resolves from the encrypted vault. Missing secrets
 *      surface in the `missing` list so callers can SKIP starting a server
 *      whose required token isn't available, instead of spawning it with an
 *      empty/placeholder value.
 *
 *   3. The expander is intentionally narrow: bare `$VAR`, `$(cmd)`, and
 *      backticks pass through unchanged. A tampered config can't smuggle
 *      shell substitution into a spawned MCP server's command line.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { homedir } from "node:os";

describe("expandPlaceholders — portable home + secret resolution", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it("expands ${HOME} to the OS home directory", async () => {
    const { expandPlaceholders } = await import("../src/mcp-client/index.js");
    const r = expandPlaceholders("${HOME}/Documents");
    expect(r.value).toBe(`${homedir()}/Documents`);
    expect(r.missing).toEqual([]);
  });

  it("expands the leading `~/` shorthand", async () => {
    const { expandPlaceholders } = await import("../src/mcp-client/index.js");
    const r = expandPlaceholders("~/projects/foo");
    expect(r.value).toBe(`${homedir()}/projects/foo`);
  });

  it("expands ${USERPROFILE} on Windows-style configs", async () => {
    const { expandPlaceholders } = await import("../src/mcp-client/index.js");
    // USERPROFILE may be unset on Linux test runners — the helper falls
    // back to homedir() so the result is always a usable path.
    const r = expandPlaceholders("${USERPROFILE}\\Documents");
    expect(r.value.endsWith("\\Documents")).toBe(true);
    expect(r.value.length).toBeGreaterThan("\\Documents".length);
  });

  it("returns missing-secret list when ${secret:NAME} can't be resolved", async () => {
    // No vault configured in test env → secret lookup returns undefined.
    const { expandPlaceholders } = await import("../src/mcp-client/index.js");
    const r = expandPlaceholders("${secret:NONEXISTENT_TOKEN}");
    expect(r.missing).toContain("NONEXISTENT_TOKEN");
    // Original placeholder preserved in the value so log output surfaces
    // the unresolved name (instead of silently injecting an empty string
    // that an MCP server might accept and then misbehave on).
    expect(r.value).toContain("${secret:NONEXISTENT_TOKEN}");
  });

  it("does NOT expand bare $VAR or $(cmd) — only the explicit ${...} forms", async () => {
    const { expandPlaceholders } = await import("../src/mcp-client/index.js");
    // These are the shell-injection vectors the narrow expander rejects.
    const cases = [
      "$HOME/Documents",        // bare $VAR — left alone
      "$(rm -rf /)",            // command substitution — passes through verbatim
      "`whoami`",               // backticks — pass through
      "${unknown_form:abc}",    // unknown placeholder — left intact
    ];
    for (const input of cases) {
      const r = expandPlaceholders(input);
      expect(r.value).toBe(input);
      expect(r.missing).toEqual([]);
    }
  });

  it("multiple placeholders expand independently in one string", async () => {
    const { expandPlaceholders } = await import("../src/mcp-client/index.js");
    const r = expandPlaceholders("${HOME}/cache/${secret:MISSING}/data");
    expect(r.value.startsWith(`${homedir()}/cache/`)).toBe(true);
    expect(r.value.endsWith("/data")).toBe(true);
    expect(r.missing).toEqual(["MISSING"]);
  });
});

describe("expandPlaceholders — secret resolution via the injected lookup", () => {
  it("resolves ${secret:NAME} when the lookup returns a value", async () => {
    const { expandPlaceholders, setSecretLookup } = await import("../src/mcp-client/index.js");
    setSecretLookup((name) => (name === "GITHUB_TOKEN" ? "ghp_test_value" : undefined));
    try {
      const r = expandPlaceholders("${secret:GITHUB_TOKEN}");
      expect(r.value).toBe("ghp_test_value");
      expect(r.missing).toEqual([]);
    } finally {
      setSecretLookup(null);
    }
  });

  it("returns missing list when the lookup yields undefined", async () => {
    const { expandPlaceholders, setSecretLookup } = await import("../src/mcp-client/index.js");
    setSecretLookup(() => undefined);
    try {
      const r = expandPlaceholders("${secret:GITHUB_TOKEN}");
      expect(r.missing).toEqual(["GITHUB_TOKEN"]);
      // Original placeholder preserved so logs surface the unresolved name.
      expect(r.value).toBe("${secret:GITHUB_TOKEN}");
    } finally {
      setSecretLookup(null);
    }
  });

  it("supports multiple ${secret:NAME} placeholders, partially resolving", async () => {
    const { expandPlaceholders, setSecretLookup } = await import("../src/mcp-client/index.js");
    setSecretLookup((name) => (name === "PRESENT" ? "yes" : undefined));
    try {
      const r = expandPlaceholders("--token=${secret:PRESENT} --db=${secret:ABSENT}");
      expect(r.value).toBe("--token=yes --db=${secret:ABSENT}");
      expect(r.missing).toEqual(["ABSENT"]);
    } finally {
      setSecretLookup(null);
    }
  });
});
