import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { generateSeatbeltProfile, isSeatbeltAvailable, wrapForSeatbelt } from "./seatbelt.js";
import { HOME_RELATIVE_DENY_DIRS, HOME_RELATIVE_DENY_FILES } from "./validate.js";

const onDarwin = process.platform === "darwin";

// Mirror seatbelt.ts sb() escaping: on Windows join() yields backslash paths,
// which the profile generator escapes for the SBPL string literal.
const sb = (p: string) => p.replace(/\\/g, "\\\\");

describe("seatbelt profile generation", () => {
  const home = "/Users/test-home";

  it("denies all outbound network", () => {
    expect(generateSeatbeltProfile(home)).toContain("(deny network*)");
  });

  it("derives sensitive-dir denies from the shared validate.ts list (no drift)", () => {
    const profile = generateSeatbeltProfile(home);
    // Every entry in the single-source list must appear as a deny subpath/literal,
    // so adding a dir to validate.ts can't silently miss the kernel sandbox.
    for (const dir of HOME_RELATIVE_DENY_DIRS) {
      expect(profile).toContain(`(subpath "${sb(join(home, dir))}")`);
    }
    for (const file of HOME_RELATIVE_DENY_FILES) {
      expect(profile).toContain(`(literal "${sb(join(home, file))}")`);
    }
  });

  it("denies writes to the launch-agent persistence vectors", () => {
    const profile = generateSeatbeltProfile(home);
    expect(profile).toContain(`(subpath "${sb(join(home, "Library/LaunchAgents"))}")`);
    expect(profile).toContain(`(subpath "/Library/LaunchAgents")`);
    expect(profile).toContain(`(literal "${sb(join(home, ".zshrc"))}")`);
  });

  it("allows the host shell by default (targeted deny, not hermetic)", () => {
    expect(generateSeatbeltProfile(home)).toContain("(allow default)");
  });
});

describe("wrapForSeatbelt", () => {
  it.skipIf(!onDarwin)("wraps with sandbox-exec -p on macOS", () => {
    const { cmd, args } = wrapForSeatbelt("/bin/bash", ["-c", "echo hi"]);
    expect(cmd).toBe("/usr/bin/sandbox-exec");
    expect(args[0]).toBe("-p");
    expect(args[2]).toBe("/bin/bash");
    expect(args.slice(3)).toEqual(["-c", "echo hi"]);
  });

  it.skipIf(onDarwin)("passes through unchanged when seatbelt unavailable", () => {
    expect(isSeatbeltAvailable()).toBe(false);
    const { cmd, args } = wrapForSeatbelt("/bin/bash", ["-c", "echo hi"]);
    expect(cmd).toBe("/bin/bash");
    expect(args).toEqual(["-c", "echo hi"]);
  });
});

// The profile is only meaningful if the kernel actually enforces it. Drive
// sandbox-exec for real against a synthetic home so we assert behavior, not
// just string content. macOS only — sandbox-exec doesn't exist elsewhere.
describe.skipIf(!onDarwin)("seatbelt enforcement (live sandbox-exec)", () => {
  function runConfined(home: string, command: string): { status: number | null; out: string } {
    const { cmd, args } = wrapForSeatbelt("/bin/bash", ["-c", command], home);
    try {
      const out = execFileSync(cmd, args, { encoding: "utf-8", timeout: 10_000, stdio: ["ignore", "pipe", "pipe"] });
      return { status: 0, out };
    } catch (e) {
      const err = e as { status?: number | null; stdout?: string; stderr?: string };
      return { status: err.status ?? null, out: (err.stdout ?? "") + (err.stderr ?? "") };
    }
  }

  it("runs an ordinary command", () => {
    const dir = mkdtempSync(join(tmpdir(), "lax-sb-home-"));
    try {
      expect(runConfined(dir, "echo alive").out.trim()).toBe("alive");
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it("blocks reads of a sensitive home dir (~/.ssh)", () => {
    const dir = mkdtempSync(join(tmpdir(), "lax-sb-home-"));
    try {
      mkdirSync(join(dir, ".ssh"));
      writeFileSync(join(dir, ".ssh", "id_rsa"), "PRIVATE-KEY");
      const r = runConfined(dir, `cat "${join(dir, ".ssh", "id_rsa")}"`);
      expect(r.out).not.toContain("PRIVATE-KEY");
      expect(r.out.toLowerCase()).toContain("operation not permitted");
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it("allows reads of a non-sensitive path under the same home", () => {
    const dir = mkdtempSync(join(tmpdir(), "lax-sb-home-"));
    try {
      writeFileSync(join(dir, "notes.txt"), "PUBLIC-NOTES");
      const r = runConfined(dir, `cat "${join(dir, "notes.txt")}"`);
      expect(r.out).toContain("PUBLIC-NOTES");
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it("blocks outbound network (bash /dev/tcp)", () => {
    const dir = mkdtempSync(join(tmpdir(), "lax-sb-home-"));
    try {
      const r = runConfined(dir, "exec 3<>/dev/tcp/1.1.1.1/80 && echo CONNECTED || echo BLOCKED");
      expect(r.out).toContain("BLOCKED");
      expect(r.out).not.toContain("CONNECTED");
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
