import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { generateBwrapArgs, isBwrapAvailable, wrapForBwrap, bwrapEnforces, bwrapServerCageRuns, bwrapGuardedRuns } from "./bwrap.js";
import { HOME_RELATIVE_DENY_DIRS, HOME_RELATIVE_DENY_FILES, SERVER_SCOPE_EXEMPT_DIRS, GUARDED_SCOPE_EXEMPT_DIRS } from "./validate.js";

const bwrapHere = isBwrapAvailable();

// Synthetic home with all deny-listed dirs/files materialized — the generator
// only emits binds for paths that exist (bwrap aborts on missing targets).
function makeHome(): string {
  const home = realpathSync(mkdtempSync(join(tmpdir(), "lax-bw-home-")));
  for (const dir of HOME_RELATIVE_DENY_DIRS) {
    mkdirSync(join(home, dir), { recursive: true });
  }
  for (const file of HOME_RELATIVE_DENY_FILES) {
    writeFileSync(join(home, file), "");
  }
  writeFileSync(join(home, ".bashrc"), "");
  return home;
}

describe("bwrap arg generation", () => {
  it("binds the host root RW and unshares the network", () => {
    const home = makeHome();
    try {
      const args = generateBwrapArgs(home);
      expect(args.slice(0, 3)).toEqual(["--bind", "/", "/"]);
      expect(args).toContain("--unshare-net");
      expect(args).toContain("--die-with-parent");
    } finally { rmSync(home, { recursive: true, force: true }); }
  });

  it("derives sensitive-path shadows from the shared validate.ts list (no drift)", () => {
    const home = makeHome();
    try {
      const args = generateBwrapArgs(home).join(" ");
      // Every entry in the single-source list must appear as a tmpfs/ro-bind,
      // so adding a path to validate.ts can't silently miss the bwrap cage.
      for (const dir of HOME_RELATIVE_DENY_DIRS) {
        expect(args).toContain(`--tmpfs ${join(home, dir)}`);
      }
      for (const file of HOME_RELATIVE_DENY_FILES) {
        expect(args).toContain(`--ro-bind /dev/null ${join(home, file)}`);
      }
    } finally { rmSync(home, { recursive: true, force: true }); }
  });

  it("shadows the shell-rc persistence vectors", () => {
    const home = makeHome();
    try {
      const args = generateBwrapArgs(home).join(" ");
      expect(args).toContain(`--ro-bind /dev/null ${join(home, ".bashrc")}`);
    } finally { rmSync(home, { recursive: true, force: true }); }
  });

  it("server scope keeps the host network namespace and exempts the server-owned dirs", () => {
    const home = makeHome();
    try {
      const args = generateBwrapArgs(home, "server");
      const joined = args.join(" ");
      expect(args).not.toContain("--unshare-net");
      expect(args).toContain("--die-with-parent");
      for (const dir of HOME_RELATIVE_DENY_DIRS) {
        if (SERVER_SCOPE_EXEMPT_DIRS.has(dir)) {
          expect(joined).not.toContain(`--tmpfs ${join(home, dir)}`);
        } else {
          expect(joined).toContain(`--tmpfs ${join(home, dir)}`);
        }
      }
      // Deny files still shadowed for the server too.
      for (const file of HOME_RELATIVE_DENY_FILES) {
        expect(joined).toContain(`--ro-bind /dev/null ${join(home, file)}`);
      }
    } finally { rmSync(home, { recursive: true, force: true }); }
  });

  it("guarded scope (default) keeps the network namespace and exempts ~/.config but still shadows the crown jewels", () => {
    const home = makeHome();
    try {
      const args = generateBwrapArgs(home, "guarded");
      const joined = args.join(" ");
      expect(args).not.toContain("--unshare-net"); // npm/git/curl keep working
      for (const dir of HOME_RELATIVE_DENY_DIRS) {
        if (GUARDED_SCOPE_EXEMPT_DIRS.has(dir)) {
          expect(joined).not.toContain(`--tmpfs ${join(home, dir)}`); // ~/.config stays readable
        } else {
          expect(joined).toContain(`--tmpfs ${join(home, dir)}`); // ~/.ssh, ~/.aws, … shadowed
        }
      }
      for (const file of HOME_RELATIVE_DENY_FILES) {
        expect(joined).toContain(`--ro-bind /dev/null ${join(home, file)}`);
      }
      expect(joined).toContain(`--ro-bind /dev/null ${join(home, ".bashrc")}`);
    } finally { rmSync(home, { recursive: true, force: true }); }
  });

  it("omits binds for paths that do not exist (bwrap aborts on missing targets)", () => {
    const home = realpathSync(mkdtempSync(join(tmpdir(), "lax-bw-home-")));
    try {
      // Empty home: no deny dir/file exists, so no shadow args at all.
      const args = generateBwrapArgs(home);
      expect(args).not.toContain("--tmpfs");
      expect(args).not.toContain("--ro-bind");
    } finally { rmSync(home, { recursive: true, force: true }); }
  });
});

describe("wrapForBwrap", () => {
  it.skipIf(!bwrapHere)("wraps with bwrap on Linux", () => {
    const { cmd, args } = wrapForBwrap("/bin/bash", ["-c", "echo hi"]);
    expect(cmd).toBe("bwrap");
    expect(args.slice(-3)).toEqual(["/bin/bash", "-c", "echo hi"]);
    expect(args).toContain("--unshare-net");
  });

  it.skipIf(bwrapHere)("passes through unchanged when bwrap unavailable", () => {
    expect(isBwrapAvailable()).toBe(false);
    const { cmd, args } = wrapForBwrap("/bin/bash", ["-c", "echo hi"]);
    expect(cmd).toBe("/bin/bash");
    expect(args).toEqual(["-c", "echo hi"]);
  });
});

// The args are only meaningful if the kernel actually enforces them. Drive
// bwrap for real against a synthetic home so we assert behavior, not just
// argv content. Linux + bwrap on PATH only.
describe.skipIf(!bwrapHere)("bwrap enforcement (live)", () => {
  function runConfined(home: string, command: string): { status: number | null; out: string } {
    const { cmd, args } = wrapForBwrap("/bin/bash", ["-c", command], home);
    try {
      const out = execFileSync(cmd, args, { encoding: "utf-8", timeout: 10_000, stdio: ["ignore", "pipe", "pipe"] });
      return { status: 0, out };
    } catch (e) {
      const err = e as { status?: number | null; stdout?: string; stderr?: string };
      return { status: err.status ?? null, out: (err.stdout ?? "") + (err.stderr ?? "") };
    }
  }

  it("runs an ordinary command", () => {
    const home = makeHome();
    try {
      expect(runConfined(home, "echo alive").out.trim()).toBe("alive");
    } finally { rmSync(home, { recursive: true, force: true }); }
  });

  it("hides a planted secret in a sensitive home dir (~/.ssh reads empty)", () => {
    const home = makeHome();
    try {
      writeFileSync(join(home, ".ssh", "id_rsa"), "PRIVATE-KEY");
      const r = runConfined(home, `cat "${join(home, ".ssh", "id_rsa")}"; ls -A "${join(home, ".ssh")}"`);
      expect(r.out).not.toContain("PRIVATE-KEY");
      expect(r.out).not.toContain("id_rsa");
    } finally { rmSync(home, { recursive: true, force: true }); }
  });

  it("allows reads of a non-sensitive path under the same home", () => {
    const home = makeHome();
    try {
      writeFileSync(join(home, "notes.txt"), "PUBLIC-NOTES");
      const r = runConfined(home, `cat "${join(home, "notes.txt")}"`);
      expect(r.out).toContain("PUBLIC-NOTES");
    } finally { rmSync(home, { recursive: true, force: true }); }
  });

  it("blocks external network (bash /dev/tcp to TEST-NET-1)", () => {
    const home = makeHome();
    try {
      const r = runConfined(home, "exec 3<>/dev/tcp/192.0.2.1/80 && echo CONNECTED || echo BLOCKED");
      expect(r.out).toContain("BLOCKED");
      expect(r.out).not.toContain("CONNECTED");
    } finally { rmSync(home, { recursive: true, force: true }); }
  });

  it("bwrapEnforces() self-check passes where the live cage holds", () => {
    const home = makeHome();
    try {
      expect(bwrapEnforces(home)).toBe(true);
    } finally { rmSync(home, { recursive: true, force: true }); }
  });

  it("bwrapServerCageRuns() self-check passes (server scope builds and execs)", () => {
    const home = makeHome();
    try {
      expect(bwrapServerCageRuns(home)).toBe(true);
    } finally { rmSync(home, { recursive: true, force: true }); }
  });

  it("bwrapGuardedRuns() self-check passes (guarded scope builds and execs)", () => {
    const home = makeHome();
    try {
      expect(bwrapGuardedRuns(home)).toBe(true);
    } finally { rmSync(home, { recursive: true, force: true }); }
  });

  it("guarded scope hides ~/.ssh but leaves ~/.config readable (dev tools keep working)", () => {
    const home = makeHome();
    try {
      writeFileSync(join(home, ".ssh", "id_rsa"), "PRIVATE-KEY");
      mkdirSync(join(home, ".config", "gh"), { recursive: true });
      writeFileSync(join(home, ".config", "gh", "hosts.yml"), "GH-CONFIG");
      const out = execFileSync(
        "bwrap",
        [...generateBwrapArgs(home, "guarded"), "/bin/bash", "-c",
          `cat "${join(home, ".ssh", "id_rsa")}" 2>&1; cat "${join(home, ".config", "gh", "hosts.yml")}" 2>&1; echo RAN`],
        { encoding: "utf-8", timeout: 10_000, stdio: ["ignore", "pipe", "pipe"] },
      );
      expect(out).toContain("RAN");
      expect(out).not.toContain("PRIVATE-KEY");
      expect(out).toContain("GH-CONFIG");
    } finally { rmSync(home, { recursive: true, force: true }); }
  });

  it("server scope still hides sensitive dirs but allows external network", () => {
    const home = makeHome();
    try {
      writeFileSync(join(home, ".ssh", "id_rsa"), "PRIVATE-KEY");
      const args = generateBwrapArgs(home, "server");
      const out = execFileSync(
        "bwrap",
        [...args, "/bin/bash", "-c", `cat "${join(home, ".ssh", "id_rsa")}" 2>&1; echo RAN`],
        { encoding: "utf-8", timeout: 10_000, stdio: ["ignore", "pipe", "pipe"] },
      );
      expect(out).toContain("RAN");
      expect(out).not.toContain("PRIVATE-KEY");
    } finally { rmSync(home, { recursive: true, force: true }); }
  });
});
