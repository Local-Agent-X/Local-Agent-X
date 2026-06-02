/**
 * SecretsStore fill-approval gating keyed on canonical origin.
 *
 * approveFill / isFillApproved / revokeFillApproval all run their `origin`
 * argument through `deriveOrigin()` (WHATWG `new URL(url).origin`) before
 * storing or comparing. That canonicalization is the load-bearing security
 * boundary: it must collapse equivalent spellings of the same origin so an
 * approval granted on one form is honored on every equivalent form, and a
 * revoke on any equivalent form clears it. If a future refactor swapped the
 * raw string in (dropping the normalize step), an attacker-controlled URL
 * spelling like `http://h:80/` could dodge a revoke that was issued against
 * `http://h/`, or fail to match an approval the user thought they granted.
 *
 * Canonicalization facts being pinned here (verified against node URL):
 *   - default port stripped:   http://h:80/    -> http://h
 *                              https://h:443/  -> https://h
 *   - scheme + host lowercased: HTTP://Host.COM/ -> http://host.com
 *   - non-default port kept:    http://h:8080/  -> http://h:8080
 *   - path/query dropped:       http://h/a?b=1  -> http://h
 *
 * Uses a real on-disk secrets.enc the test owns (per-test temp dataDir);
 * no keychain mocking — same pattern as secrets-quarantine.test.ts.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { SecretsStore, deriveOrigin } from "../src/secrets.js";

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "lax-secrets-origin-test-"));
});

afterEach(() => {
  try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
});

describe("deriveOrigin canonicalization", () => {
  it("strips the scheme's default port", () => {
    expect(deriveOrigin("http://h:80/")).toBe("http://h");
    expect(deriveOrigin("http://h/")).toBe("http://h");
    expect(deriveOrigin("https://h:443/")).toBe("https://h");
    expect(deriveOrigin("https://h/")).toBe("https://h");
  });

  it("lowercases scheme and host, and drops path/query", () => {
    expect(deriveOrigin("HTTP://Host.COM:80/foo?bar=1")).toBe("http://host.com");
  });

  it("keeps a non-default port distinct", () => {
    expect(deriveOrigin("http://h:8080/")).toBe("http://h:8080");
    expect(deriveOrigin("http://h:8080/")).not.toBe(deriveOrigin("http://h/"));
  });

  it("returns undefined for empty / unparseable input", () => {
    expect(deriveOrigin(undefined)).toBeUndefined();
    expect(deriveOrigin(null)).toBeUndefined();
    expect(deriveOrigin("")).toBeUndefined();
    expect(deriveOrigin("not a url")).toBeUndefined();
  });
});

describe("approveFill / isFillApproved / revokeFillApproval — origin gating", () => {
  it("approval on one canonical form is honored on every equivalent form", () => {
    const store = new SecretsStore(tmpDir);
    store.set("API_KEY", "sk-secret");

    // Approve using the explicit-default-port spelling.
    expect(store.approveFill("API_KEY", "http://h:80/")).toBe(true);

    // Every equivalent spelling of the same origin must read as approved.
    expect(store.isFillApproved("API_KEY", "http://h:80/")).toBe(true);
    expect(store.isFillApproved("API_KEY", "http://h/")).toBe(true);
    expect(store.isFillApproved("API_KEY", "http://h")).toBe(true);
    expect(store.isFillApproved("API_KEY", "HTTP://H/")).toBe(true);
    expect(store.isFillApproved("API_KEY", "http://h/some/path?q=1")).toBe(true);

    // The stored origin is the canonical form, not the raw input.
    const meta = store.getMeta("API_KEY")!;
    expect(meta.approvedFills).toEqual([
      expect.objectContaining({ origin: "http://h" }),
    ]);
  });

  it("a different origin (non-default port) is NOT approved by the bare-host approval", () => {
    const store = new SecretsStore(tmpDir);
    store.set("API_KEY", "sk-secret");
    store.approveFill("API_KEY", "http://h/");

    expect(store.isFillApproved("API_KEY", "http://h:8080/")).toBe(false);
    expect(store.isFillApproved("API_KEY", "https://h/")).toBe(false);
    expect(store.isFillApproved("API_KEY", "http://other/")).toBe(false);
  });

  it("revoke on an equivalent form clears the approval granted on another form", () => {
    const store = new SecretsStore(tmpDir);
    store.set("API_KEY", "sk-secret");
    store.approveFill("API_KEY", "https://h:443/login");
    expect(store.isFillApproved("API_KEY", "https://h/")).toBe(true);

    // Revoke using a different-but-equivalent spelling (no explicit port).
    expect(store.revokeFillApproval("API_KEY", "https://h/anything")).toBe(true);

    // Cleared for every equivalent form.
    expect(store.isFillApproved("API_KEY", "https://h/")).toBe(false);
    expect(store.isFillApproved("API_KEY", "https://h:443/")).toBe(false);
    expect(store.getMeta("API_KEY")!.approvedFills).toEqual([]);
  });

  it("approveFill is idempotent across equivalent spellings (no duplicate rows)", () => {
    const store = new SecretsStore(tmpDir);
    store.set("API_KEY", "sk-secret");

    expect(store.approveFill("API_KEY", "http://h/")).toBe(true);
    // Re-approving an equivalent spelling is a no-op that still reports true.
    expect(store.approveFill("API_KEY", "http://h:80/")).toBe(true);
    expect(store.approveFill("API_KEY", "HTTP://H")).toBe(true);

    expect(store.getMeta("API_KEY")!.approvedFills).toHaveLength(1);
  });

  it("approval gating survives a cold reload (persisted as canonical origin)", () => {
    const seed = new SecretsStore(tmpDir);
    seed.set("API_KEY", "sk-secret");
    seed.approveFill("API_KEY", "HTTP://Host.COM:80/dashboard");

    // Cold-boot a fresh store from the same on-disk file.
    const reloaded = new SecretsStore(tmpDir);
    expect(reloaded.isFillApproved("API_KEY", "http://host.com/")).toBe(true);
    expect(reloaded.isFillApproved("API_KEY", "http://host.com:80/x")).toBe(true);
    expect(reloaded.isFillApproved("API_KEY", "http://host.com:80")).toBe(true);

    // Revoke after reload clears it on disk too.
    expect(reloaded.revokeFillApproval("API_KEY", "http://host.com")).toBe(true);
    const reloaded2 = new SecretsStore(tmpDir);
    expect(reloaded2.isFillApproved("API_KEY", "http://host.com/")).toBe(false);
  });

  it("operations on an unknown secret are safe no-ops", () => {
    const store = new SecretsStore(tmpDir);
    expect(store.approveFill("NOPE", "http://h/")).toBe(false);
    expect(store.isFillApproved("NOPE", "http://h/")).toBe(false);
    expect(store.revokeFillApproval("NOPE", "http://h/")).toBe(false);
  });

  it("revoke returns false when the origin was never approved", () => {
    const store = new SecretsStore(tmpDir);
    store.set("API_KEY", "sk-secret");
    // No approvedFills array at all yet.
    expect(store.revokeFillApproval("API_KEY", "http://h/")).toBe(false);
    store.approveFill("API_KEY", "http://h/");
    // Approved set exists but this origin isn't in it.
    expect(store.revokeFillApproval("API_KEY", "http://other/")).toBe(false);
  });

  it("an unparseable origin falls back to the raw string and matches itself only", () => {
    // deriveOrigin() fails on a non-URL, so approveFill stores the raw
    // string verbatim. This pins that fallback: the un-normalized form
    // matches exactly itself but does NOT cross-match any canonical origin.
    const store = new SecretsStore(tmpDir);
    store.set("API_KEY", "sk-secret");
    expect(store.approveFill("API_KEY", "garbage-origin")).toBe(true);

    expect(store.getMeta("API_KEY")!.approvedFills).toEqual([
      expect.objectContaining({ origin: "garbage-origin" }),
    ]);
    expect(store.isFillApproved("API_KEY", "garbage-origin")).toBe(true);
    expect(store.isFillApproved("API_KEY", "http://garbage-origin/")).toBe(false);
  });
});

describe("resolve / findMissing placeholder handling", () => {
  it("resolve substitutes known secrets and leaves unknown placeholders intact", () => {
    const store = new SecretsStore(tmpDir);
    store.set("TOKEN", "abc123");
    expect(store.resolve("Bearer {{TOKEN}}")).toBe("Bearer abc123");
    // Unknown placeholder is left verbatim, not blanked.
    expect(store.resolve("X {{MISSING}} Y")).toBe("X {{MISSING}} Y");
    // Mixed.
    expect(store.resolve("{{TOKEN}}/{{MISSING}}")).toBe("abc123/{{MISSING}}");
  });

  it("findMissing reports only placeholders absent from the store", () => {
    const store = new SecretsStore(tmpDir);
    store.set("PRESENT", "v");
    expect(store.findMissing("{{PRESENT}} {{GONE}} {{ALSO_GONE}}"))
      .toEqual(["GONE", "ALSO_GONE"]);
    expect(store.findMissing("{{PRESENT}}")).toEqual([]);
    expect(store.findMissing("no placeholders here")).toEqual([]);
  });
});
