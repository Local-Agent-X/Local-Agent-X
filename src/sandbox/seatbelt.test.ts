import { describe, it, expect } from "vitest";
import { execFile, execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { generateSeatbeltProfile, isSeatbeltAvailable, seatbeltProfileLoads, wrapForSeatbelt, SANDBOX_EXEC } from "./seatbelt.js";
import { HOME_RELATIVE_DENY_DIRS, HOME_RELATIVE_DENY_FILES, SERVER_SCOPE_EXEMPT_DIRS, GUARDED_SCOPE_EXEMPT_DIRS } from "./validate.js";

const onDarwin = process.platform === "darwin";

// Mirror seatbelt.ts sb() escaping: on Windows join() yields backslash paths,
// which the profile generator escapes for the SBPL string literal.
const sb = (p: string) => p.replace(/\\/g, "\\\\");

describe("seatbelt profile generation", () => {
  const home = "/Users/test-home";

  it("strict shell scope denies ALL network with no carve-outs", () => {
    const profile = generateSeatbeltProfile(home);
    expect(profile).toContain("(deny network*)");
    // Blanket deny: strict must have no loopback/unix-socket allows.
    expect(profile).not.toContain("(allow network");
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

  it("server scope has no network rules at all and exempts the server-owned dirs", () => {
    const profile = generateSeatbeltProfile(home, "server");
    // Server egress is governed in-process by canonicalFetch, not SBPL.
    expect(profile).not.toContain("network");
    for (const dir of HOME_RELATIVE_DENY_DIRS) {
      const entry = `(subpath "${sb(join(home, dir))}")`;
      if (SERVER_SCOPE_EXEMPT_DIRS.has(dir)) {
        expect(profile).not.toContain(entry);
      } else {
        expect(profile).toContain(entry);
      }
    }
    // Deny files and persistence write-denies still apply to the server.
    for (const file of HOME_RELATIVE_DENY_FILES) {
      expect(profile).toContain(`(literal "${sb(join(home, file))}")`);
    }
    expect(profile).toContain(`(subpath "${sb(join(home, "Library/LaunchAgents"))}")`);
  });

  it("guarded scope (default) confines network to loopback and exempts ~/.config but still denies the crown jewels", () => {
    const profile = generateSeatbeltProfile(home, "guarded");
    // Network invariant: anything ON the machine, nothing OFF it.
    expect(profile).toContain("(deny network*)");
    expect(profile).toContain(`(allow network-outbound (remote ip "localhost:*"))`);
    expect(profile).toContain(`(allow network-bind (local ip "*:*"))`);
    expect(profile).toContain(`(allow network-inbound (local ip "*:*"))`);
    expect(profile).toContain("(allow network* (remote unix-socket))");
    expect(profile).toContain("(allow network* (local unix-socket))");
    for (const dir of HOME_RELATIVE_DENY_DIRS) {
      const entry = `(subpath "${sb(join(home, dir))}")`;
      if (GUARDED_SCOPE_EXEMPT_DIRS.has(dir)) {
        expect(profile).not.toContain(entry); // ~/.config stays readable (dev tools)
      } else {
        expect(profile).toContain(entry); // ~/.ssh, ~/.aws, … still denied
      }
    }
    // Credential files + persistence write-denies still apply.
    for (const file of HOME_RELATIVE_DENY_FILES) {
      expect(profile).toContain(`(literal "${sb(join(home, file))}")`);
    }
    expect(profile).toContain(`(literal "${sb(join(home, ".zshrc"))}")`);
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

  it.skipIf(onDarwin)("fails closed when a cached backend requires a missing sandbox-exec", () => {
    expect(() => wrapForSeatbelt("/bin/bash", ["-c", "echo hi"], undefined, "guarded", true))
      .toThrow(/Required sandbox executable is unavailable/);
  });
});

// Ephemeral UNCONFINED loopback HTTP listener for the live network probes:
// the caged process connects to it (or must fail to). Port 0 = OS-assigned.
async function withLoopbackListener(fn: (port: number) => void | Promise<void>): Promise<void> {
  const srv = createServer((_req, res) => { res.end("LOOPBACK-OK"); });
  await new Promise<void>((resolve) => srv.listen(0, "127.0.0.1", resolve));
  try {
    await fn((srv.address() as AddressInfo).port);
  } finally {
    await new Promise<void>((resolve) => srv.close(() => resolve()));
  }
}

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

  it("strict scope blocks even loopback (blanket deny — regression pin vs guarded)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "lax-sb-home-"));
    try {
      await withLoopbackListener(async (port) => {
        const r = runConfined(dir, `exec 3<>/dev/tcp/127.0.0.1/${port} && echo CONNECTED || echo BLOCKED`);
        expect(r.out).toContain("BLOCKED");
        expect(r.out).not.toContain("CONNECTED");
      });
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});

// Server-scope profile, driven live — this is the cage the whole Node server
// runs under in phase B, so prove the three properties that matter: sensitive
// dirs are kernel-unreadable, the server-owned dir (~/.lax analog) stays
// writable, and the profile itself loads.
describe.skipIf(!onDarwin)("seatbelt server-scope enforcement (live sandbox-exec)", () => {
  function runServerConfined(home: string, command: string): { status: number | null; out: string } {
    const profile = generateSeatbeltProfile(home, "server");
    try {
      const out = execFileSync(SANDBOX_EXEC, ["-p", profile, "/bin/bash", "-c", command],
        { encoding: "utf-8", timeout: 10_000, stdio: ["ignore", "pipe", "pipe"] });
      return { status: 0, out };
    } catch (e) {
      const err = e as { status?: number | null; stdout?: string; stderr?: string };
      return { status: err.status ?? null, out: (err.stdout ?? "") + (err.stderr ?? "") };
    }
  }

  it("server profile loads (self-check)", () => {
    const dir = mkdtempSync(join(tmpdir(), "lax-sb-srv-"));
    try {
      expect(seatbeltProfileLoads(dir, "server")).toBe(true);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it("still blocks reads of a sensitive home dir (~/.ssh)", () => {
    const dir = mkdtempSync(join(tmpdir(), "lax-sb-srv-"));
    try {
      mkdirSync(join(dir, ".ssh"));
      writeFileSync(join(dir, ".ssh", "id_rsa"), "PRIVATE-KEY");
      const r = runServerConfined(dir, `cat "${join(dir, ".ssh", "id_rsa")}"`);
      expect(r.out).not.toContain("PRIVATE-KEY");
      expect(r.out.toLowerCase()).toContain("operation not permitted");
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it("allows reads AND writes in the server-owned ~/.lax analog", () => {
    const dir = mkdtempSync(join(tmpdir(), "lax-sb-srv-"));
    try {
      mkdirSync(join(dir, ".lax"));
      const r = runServerConfined(dir, `echo STATE > "${join(dir, ".lax", "state.txt")}" && cat "${join(dir, ".lax", "state.txt")}"`);
      expect(r.out).toContain("STATE");
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it("still denies writes to the persistence vectors (~/.zshrc)", () => {
    const dir = mkdtempSync(join(tmpdir(), "lax-sb-srv-"));
    try {
      writeFileSync(join(dir, ".zshrc"), "# original");
      const r = runServerConfined(dir, `echo pwned >> "${join(dir, ".zshrc")}" && echo WROTE || echo DENIED`);
      expect(r.out).toContain("DENIED");
      expect(r.out).not.toContain("WROTE");
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});

// Guarded scope is the DEFAULT shell cage. Prove the properties that make it
// the right default: the credential crown jewels are kernel-unreadable (so a
// $VAR/$(...) read the parser missed still can't reach ~/.ssh), ~/.config —
// where gh/git/etc. keep their config — stays readable so dev tools don't
// break, and the network invariant holds: anything ON the machine (loopback
// outbound, bind/listen, localhost-by-name), nothing OFF it (TEST-NET-1).
describe.skipIf(!onDarwin)("seatbelt guarded-scope enforcement (live sandbox-exec)", () => {
  function runGuarded(home: string, command: string): { status: number | null; out: string } {
    const { cmd, args } = wrapForSeatbelt("/bin/bash", ["-c", command], home, "guarded");
    try {
      const out = execFileSync(cmd, args, { encoding: "utf-8", timeout: 10_000, stdio: ["ignore", "pipe", "pipe"] });
      return { status: 0, out };
    } catch (e) {
      const err = e as { status?: number | null; stdout?: string; stderr?: string };
      return { status: err.status ?? null, out: (err.stdout ?? "") + (err.stderr ?? "") };
    }
  }

  it("still blocks reads of ~/.ssh (the crown jewel)", () => {
    const dir = mkdtempSync(join(tmpdir(), "lax-sb-grd-"));
    try {
      mkdirSync(join(dir, ".ssh"));
      writeFileSync(join(dir, ".ssh", "id_rsa"), "PRIVATE-KEY");
      const r = runGuarded(dir, `cat "${join(dir, ".ssh", "id_rsa")}"`);
      expect(r.out).not.toContain("PRIVATE-KEY");
      expect(r.out.toLowerCase()).toContain("operation not permitted");
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it("ALLOWS reads of ~/.config so dev tools (gh/git) keep working", () => {
    const dir = mkdtempSync(join(tmpdir(), "lax-sb-grd-"));
    try {
      mkdirSync(join(dir, ".config", "gh"), { recursive: true });
      writeFileSync(join(dir, ".config", "gh", "hosts.yml"), "GH-CONFIG");
      const r = runGuarded(dir, `cat "${join(dir, ".config", "gh", "hosts.yml")}"`);
      expect(r.out).toContain("GH-CONFIG");
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it("blocks outbound TCP off-machine (TEST-NET-1 — RFC 5737, no real traffic leaves)", () => {
    const dir = mkdtempSync(join(tmpdir(), "lax-sb-grd-"));
    try {
      // Denied at the syscall → fails instantly with EPERM, no timeout wait.
      const r = runGuarded(dir, "exec 3<>/dev/tcp/192.0.2.1/80 && echo NET-OK || echo NET-BLOCKED");
      expect(r.out).toContain("NET-BLOCKED");
      expect(r.out).not.toContain("NET-OK");
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  // Async runner for probes that talk BACK to a listener inside this vitest
  // process: execFileSync would block the event loop and deadlock the server
  // (curl waits for a response the server can never send), so these must not
  // be synchronous.
  function runGuardedAsync(home: string, command: string): Promise<{ out: string }> {
    const { cmd, args } = wrapForSeatbelt("/bin/bash", ["-c", command], home, "guarded");
    return new Promise((resolve) => {
      execFile(cmd, args, { encoding: "utf-8", timeout: 10_000 }, (_err, stdout, stderr) => {
        resolve({ out: stdout + stderr });
      });
    });
  }

  it("ALLOWS outbound TCP to a loopback listener", async () => {
    const dir = mkdtempSync(join(tmpdir(), "lax-sb-grd-"));
    try {
      await withLoopbackListener(async (port) => {
        const r = await runGuardedAsync(dir, `/usr/bin/curl -sS --max-time 3 http://127.0.0.1:${port}/`);
        expect(r.out).toContain("LOOPBACK-OK");
      });
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it("ALLOWS connecting to localhost by NAME (resolver path survives the network deny)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "lax-sb-grd-"));
    try {
      await withLoopbackListener(async (port) => {
        // By NAME, not IP: proves getaddrinfo still works inside the cage
        // (resolution rides the system resolver daemon — decision D8).
        const r = await runGuardedAsync(dir, `/usr/bin/curl -sS --max-time 3 http://localhost:${port}/`);
        expect(r.out).toContain("LOOPBACK-OK");
      });
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it("ALLOWS binding + listening on a loopback port (dev servers must serve)", () => {
    const dir = mkdtempSync(join(tmpdir(), "lax-sb-grd-"));
    try {
      const script = 'const s=require("net").createServer();s.listen(0,"127.0.0.1",()=>{console.log("BIND-OK "+s.address().port);s.close()})';
      const r = runGuarded(dir, `"${process.execPath}" -e '${script}'`);
      expect(r.out).toContain("BIND-OK");
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it("ALLOWS unix-domain sockets (on-machine IPC: docker.sock, ssh-agent, postgres)", () => {
    const dir = mkdtempSync(join(tmpdir(), "lax-sb-grd-"));
    // Bind + connect a UDS entirely inside the cage; short path (tmpdir) to
    // stay under the sun_path length limit.
    const sockDir = mkdtempSync(join(tmpdir(), "lax-sb-uds-"));
    try {
      const sock = join(sockDir, "s");
      const script = `const n=require("net");const s=n.createServer(c=>{c.end("UDS-OK")});s.listen(${JSON.stringify(sock)},()=>{const c=n.connect(${JSON.stringify(sock)});c.on("data",d=>{console.log(d.toString());s.close()})})`;
      const r = runGuarded(dir, `"${process.execPath}" -e '${script}'`);
      expect(r.out).toContain("UDS-OK");
    } finally {
      rmSync(dir, { recursive: true, force: true });
      rmSync(sockDir, { recursive: true, force: true });
    }
  });
});
