import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { generateBwrapArgs, isBwrapAvailable, resolveBwrapPath, wrapForBwrap, bwrapEnforces, bwrapServerCageRuns, bwrapGuardedRuns } from "./bwrap.js";
import { HOME_RELATIVE_DENY_DIRS, HOME_RELATIVE_DENY_FILES, SERVER_SCOPE_EXEMPT_DIRS, GUARDED_SCOPE_EXEMPT_DIRS } from "./validate.js";
import { installRootWriteRule, type InstallRootRule } from "../security/layer/install-root.js";
import { installRootDenialHint } from "./denial-hints.js";

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

  // Read-only over itself, not shadowed: a login shell in the cage still
  // reads it, and nothing the cage runs can change it.
  it("binds the shell-rc persistence vectors read-only over themselves", () => {
    const home = makeHome();
    try {
      const args = generateBwrapArgs(home).join(" ");
      expect(args).toContain(`--ro-bind ${join(home, ".bashrc")} ${join(home, ".bashrc")}`);
      expect(args).not.toContain(`--ro-bind /dev/null ${join(home, ".bashrc")}`);
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
      expect(joined).toContain(`--ro-bind ${join(home, ".bashrc")} ${join(home, ".bashrc")}`);
    } finally { rmSync(home, { recursive: true, force: true }); }
  });

  it("omits binds for paths that do not exist (bwrap aborts on missing targets)", () => {
    const home = realpathSync(mkdtempSync(join(tmpdir(), "lax-bw-home-")));
    try {
      // Empty home and no install rule: no deny dir/file exists, so no shadow args at all.
      const args = generateBwrapArgs(home, "shell", undefined, null);
      expect(args).not.toContain("--tmpfs");
      expect(args).not.toContain("--ro-bind");
    } finally { rmSync(home, { recursive: true, force: true }); }
  });
});

// The install folder is write-protected for the agent except its workspace,
// config/ included (security/layer/install-root.ts). bwrap applies mounts in
// order, so the order IS the rule: the root bind, then the install read-only,
// then the workspace bound back read-write, then the home shadows on top.
describe("bwrap install-root write deny", () => {
  function makeInstall(): { base: string; rule: InstallRootRule } {
    const base = realpathSync(mkdtempSync(join(tmpdir(), "lax-bw-install-")));
    const root = join(base, "install");
    mkdirSync(join(root, "workspace"), { recursive: true });
    mkdirSync(join(root, "config"), { recursive: true });
    for (const f of ["system-prompt.md", "tools.json", "protected-files.json"]) writeFileSync(join(root, "config", f), "{}");
    return { base, rule: installRootWriteRule(root, join(root, "workspace"))! };
  }
  const at = (args: string[], ...seq: string[]) =>
    args.findIndex((_, i) => seq.every((s, j) => args[i + j] === s));

  it("agent scopes bind the install read-only, then only the workspace read-write, before the home shadows", () => {
    const home = makeHome();
    const { base, rule } = makeInstall();
    const ws = join(rule.root, "workspace");
    try {
      for (const scope of ["shell", "guarded"] as const) {
        const args = generateBwrapArgs(home, scope, { network: "namespace" }, rule);
        const ro = at(args, "--ro-bind", rule.root, rule.root);
        const rw = at(args, "--bind", ws, ws);
        expect(ro, scope).toBeGreaterThan(at(args, "--bind", "/", "/"));
        expect(rw, scope).toBeGreaterThan(ro);
        expect(rw, scope).toBeLessThan(args.indexOf("--tmpfs"));
        expect(args.filter((a) => a.startsWith(join(rule.root, "config"))), scope).toEqual([]);
      }
    } finally {
      rmSync(home, { recursive: true, force: true });
      rmSync(base, { recursive: true, force: true });
    }
  });

  it("server scope never carries it: the server writes its own install", () => {
    const home = makeHome();
    const { base, rule } = makeInstall();
    try {
      expect(generateBwrapArgs(home, "server", undefined, rule)).not.toContain(rule.root);
    } finally {
      rmSync(home, { recursive: true, force: true });
      rmSync(base, { recursive: true, force: true });
    }
  });

  it("skips a writable folder that does not exist yet (bwrap aborts on a missing bind source)", () => {
    const { base, rule } = makeInstall();
    try {
      const missing = join(rule.root, "not-yet");
      const args = generateBwrapArgs(base, "guarded", undefined, { root: rule.root, writable: [missing] });
      expect(at(args, "--ro-bind", rule.root, rule.root)).toBeGreaterThan(-1);
      expect(args).not.toContain(missing);
    } finally { rmSync(base, { recursive: true, force: true }); }
  });

  it("by default reads the live install root", () => {
    const live = installRootWriteRule();
    expect(live).not.toBeNull();
    const home = makeHome();
    try {
      const args = generateBwrapArgs(home, "guarded");
      expect(at(args, "--ro-bind", live!.root, live!.root)).toBeGreaterThan(-1);
    } finally { rmSync(home, { recursive: true, force: true }); }
  });

  it.skipIf(!bwrapHere)("live: a write into the install is refused and one into its workspace lands", () => {
    const home = makeHome();
    const { base, rule } = makeInstall();
    const ws = rule.writable[0]!;
    try {
      const out = execFileSync(
        resolveBwrapPath()!,
        [...generateBwrapArgs(home, "guarded", { network: "namespace" }, rule), "/bin/bash", "-c",
          `(echo x > "${rule.root}/engine.js") 2>/dev/null && echo ROOT-WROTE || echo ROOT-DENIED; ` +
          `echo y > "${ws}/note.md" && echo WS-WROTE || echo WS-DENIED`],
        { encoding: "utf-8", timeout: 10_000, stdio: ["ignore", "pipe", "pipe"] },
      );
      expect(out).toContain("ROOT-DENIED");
      expect(out).toContain("WS-WROTE");
    } finally {
      rmSync(home, { recursive: true, force: true });
      rmSync(base, { recursive: true, force: true });
    }
  });

  // The refusal is what the shell's notice keys on (denial-hints.ts), so the
  // live output is fed back to it: a capture, not an invented string.
  it.skipIf(!bwrapHere)("live: writes into config/ are refused — the prompt, tools.json, the protected-files list — and the notice names the rule", () => {
    const home = makeHome();
    const { base, rule } = makeInstall();
    try {
      const out = execFileSync(
        resolveBwrapPath()!,
        [...generateBwrapArgs(home, "guarded", { network: "namespace" }, rule), "/bin/bash", "-c",
          `for f in system-prompt.md tools.json protected-files.json; do (echo x > "${rule.root}/config/$f") && echo "$f-WROTE" || echo "$f-DENIED"; done; ` +
          `(rm "${rule.root}/config/tools.json") && echo RM-REMOVED || echo RM-KEPT; ` +
          `(echo x > "${rule.root}/config/new.json") 2>&1; true`],
        { encoding: "utf-8", timeout: 10_000, stdio: ["ignore", "pipe", "pipe"] },
      );
      for (const f of ["system-prompt.md", "tools.json", "protected-files.json"]) expect(out).toContain(`${f}-DENIED`);
      expect(out).toContain("RM-KEPT");
      expect(installRootDenialHint("guarded", out, "linux", rule)).toContain("install folder");
    } finally {
      rmSync(home, { recursive: true, force: true });
      rmSync(base, { recursive: true, force: true });
    }
  });
});

describe("bwrap guarded network (BwrapNetwork)", () => {
  it("guarded keeps the host network unless the caller asks for a namespace", () => {
    const home = makeHome();
    try {
      expect(generateBwrapArgs(home, "guarded")).not.toContain("--unshare-net");
      expect(generateBwrapArgs(home, "guarded", { network: "host" })).not.toContain("--unshare-net");
      expect(generateBwrapArgs(home, "guarded", { network: "namespace" })).toContain("--unshare-net");
      // Strict is always a namespace, whatever the caller says.
      expect(generateBwrapArgs(home, "shell", { network: "host" })).toContain("--unshare-net");
    } finally { rmSync(home, { recursive: true, force: true }); }
  });

  it("bind-mounts the bridge socket only when it exists, and never for strict", () => {
    const home = makeHome();
    try {
      const sock = join(home, "bridge.sock");
      const missing = generateBwrapArgs(home, "guarded", { network: "namespace", bridge: { socketPath: sock, port: 60090 } });
      expect(missing).not.toContain(sock);
      writeFileSync(sock, "");
      const present = generateBwrapArgs(home, "guarded", { network: "namespace", bridge: { socketPath: sock, port: 60090 } });
      expect(present.join(" ")).toContain(`--bind ${sock} ${sock}`);
      expect(generateBwrapArgs(home, "shell", { network: "namespace", bridge: { socketPath: sock, port: 60090 } })).not.toContain(sock);
    } finally { rmSync(home, { recursive: true, force: true }); }
  });

  it("the bridge socket under the data dir is mounted after the tmpfs that shadows ~/.lax", () => {
    const home = makeHome();
    try {
      mkdirSync(join(home, ".lax", "run"), { recursive: true });
      const sock = join(home, ".lax", "run", "shell-egress-1.sock");
      writeFileSync(sock, "");
      const args = generateBwrapArgs(home, "guarded", { network: "namespace", bridge: { socketPath: sock, port: 60090 } });
      const shadow = args.indexOf(join(home, ".lax"));
      expect(args[shadow - 1]).toBe("--tmpfs");
      expect(args.indexOf(sock)).toBeGreaterThan(shadow);
    } finally { rmSync(home, { recursive: true, force: true }); }
  });

  it.skipIf(!bwrapHere)("with a bridge the cage's first process is the forwarder, then the shell", () => {
    const home = makeHome();
    try {
      const sock = join(home, "bridge.sock");
      writeFileSync(sock, "");
      const { args } = wrapForBwrap("/bin/bash", ["-c", "true"], home, "guarded", { network: "namespace", bridge: { socketPath: sock, port: 60090 } });
      const at = args.indexOf(process.execPath);
      expect(at).toBeGreaterThan(0);
      // node's own proxy-agent warning must not land in the shell's output.
      expect(args.slice(at + 1, at + 3)).toEqual(["--no-warnings", "-e"]);
      expect(args.slice(at + 4)).toEqual(["--", sock, "60090", "--", "/bin/bash", "-c", "true"]);
      // Registered local-service ports ride along, the proxy's first and never twice.
      const withPorts = wrapForBwrap("/bin/bash", ["-c", "true"], home, "guarded",
        { network: "namespace", bridge: { socketPath: sock, port: 60090, loopbackPorts: [7007, 60090, 3000] } }).args;
      // The socket path also appears earlier as a bind mount, so index from
      // the forwarder's argv: execPath, --no-warnings, -e, source, --, sock, ports.
      expect(withPorts[withPorts.indexOf(process.execPath) + 6]).toBe("60090,7007,3000");
    } finally { rmSync(home, { recursive: true, force: true }); }
  });
});

describe.skipIf(!bwrapHere)("bwrap guarded namespace (live)", () => {
  it("guarded in a namespace blocks external network and reports no route (the hint's anchor)", () => {
    const home = makeHome();
    try {
      const out = execFileSync(
        resolveBwrapPath()!,
        [...generateBwrapArgs(home, "guarded", { network: "namespace" }), "/bin/bash", "-c",
          "exec 3<>/dev/tcp/192.0.2.1/80 && echo NET-OK || echo NET-BLOCKED"],
        { encoding: "utf-8", timeout: 10_000, stdio: ["ignore", "pipe", "pipe"] },
      );
      expect(out).toContain("NET-BLOCKED");
      expect(out).not.toContain("NET-OK");
    } finally { rmSync(home, { recursive: true, force: true }); }
  });

  it("a bridged guarded shell reaches the host through the socket and nothing else on loopback", async () => {
    const { createServer } = await import("node:net");
    const { execFile } = await import("node:child_process");
    const home = makeHome();
    const sock = join(home, "b.sock");
    // Answers every line, including the forwarder's port preamble, as HOST:<line>.
    const echo = createServer((c) => c.on("data", (d) => { for (const l of d.toString().split("\n")) if (l.trim()) c.write(`HOST:${l.trim()}\n`); }));
    await new Promise<void>((r) => echo.listen(sock, r));
    // A second host listener on loopback, NOT bridged: unreachable from the cage.
    const stray = createServer((c) => c.end("STRAY\n"));
    const strayPort = await new Promise<number>((r) => stray.listen(0, "127.0.0.1", () => { const a = stray.address(); r(typeof a === "object" && a ? a.port : 0); }));
    try {
      const port = 60095;
      const { cmd, args } = wrapForBwrap("/bin/bash", ["-c",
        `exec 3<>/dev/tcp/127.0.0.1/${port}; echo ping >&3; read -t 3 pre <&3; read -t 3 line <&3; echo "PRE:$pre GOT:$line"; ` +
        `(exec 4<>/dev/tcp/127.0.0.1/${strayPort}) 2>&1 && echo STRAY-REACHED || echo STRAY-BLOCKED`],
        home, "guarded", { network: "namespace", bridge: { socketPath: sock, port } });
      const out = await new Promise<string>((resolve) => execFile(cmd, args, { encoding: "utf-8", timeout: 15_000 }, (_e, so, se) => resolve(so + se)));
      expect(out).toContain(`PRE:HOST:${port} GOT:HOST:ping`);
      expect(out).toContain("STRAY-BLOCKED");
      expect(out).not.toContain("STRAY-REACHED");
    } finally {
      await new Promise<void>((r) => echo.close(() => r()));
      await new Promise<void>((r) => stray.close(() => r()));
      rmSync(home, { recursive: true, force: true });
    }
  });
});

describe("wrapForBwrap", () => {
  it.skipIf(process.platform !== "linux")("resolves an absolute executable from the host PATH", () => {
    const dir = mkdtempSync(join(tmpdir(), "lax-fake-bwrap-"));
    const fake = join(dir, "bwrap");
    writeFileSync(fake, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    try {
      expect(resolveBwrapPath(dir)).toBe(realpathSync(fake));
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it.skipIf(!bwrapHere)("wraps with bwrap on Linux", () => {
    const { cmd, args } = wrapForBwrap("/bin/bash", ["-c", "echo hi"]);
    expect(cmd).toBe(resolveBwrapPath());
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
        resolveBwrapPath()!,
        [...generateBwrapArgs(home, "guarded"), "/bin/bash", "-c",
          `cat "${join(home, ".ssh", "id_rsa")}" 2>&1; cat "${join(home, ".config", "gh", "hosts.yml")}" 2>&1; echo RAN`],
        { encoding: "utf-8", timeout: 10_000, stdio: ["ignore", "pipe", "pipe"] },
      );
      expect(out).toContain("RAN");
      expect(out).not.toContain("PRIVATE-KEY");
      expect(out).toContain("GH-CONFIG");
    } finally { rmSync(home, { recursive: true, force: true }); }
  });

  // The persistence locations read normally (git still finds who you are)
  // and refuse every write, in the default scope.
  it("guarded scope: ~/.gitconfig and ~/.bashrc read, and refuse a write", () => {
    const home = makeHome();
    try {
      writeFileSync(join(home, ".gitconfig"), "[user]\n\tname = Original\n");
      mkdirSync(join(home, ".config", "systemd", "user"), { recursive: true });
      const out = execFileSync(
        resolveBwrapPath()!,
        [...generateBwrapArgs(home, "guarded", { network: "namespace" }), "/bin/bash", "-c",
          `cat "${join(home, ".gitconfig")}"; ` +
          `(echo pwned >> "${join(home, ".gitconfig")}") 2>/dev/null && echo GIT-WROTE || echo GIT-DENIED; ` +
          `(echo pwned >> "${join(home, ".bashrc")}") 2>/dev/null && echo RC-WROTE || echo RC-DENIED; ` +
          `(echo x > "${join(home, ".config", "systemd", "user", "x.service")}") 2>/dev/null && echo UNIT-WROTE || echo UNIT-DENIED`],
        { encoding: "utf-8", timeout: 10_000, stdio: ["ignore", "pipe", "pipe"] },
      );
      expect(out).toContain("name = Original");
      expect(out).toContain("GIT-DENIED");
      expect(out).toContain("RC-DENIED");
      expect(out).toContain("UNIT-DENIED");
    } finally { rmSync(home, { recursive: true, force: true }); }
  });

  it("server scope still hides sensitive dirs but allows external network", () => {
    const home = makeHome();
    try {
      writeFileSync(join(home, ".ssh", "id_rsa"), "PRIVATE-KEY");
      const args = generateBwrapArgs(home, "server");
      const out = execFileSync(
        resolveBwrapPath()!,
        [...args, "/bin/bash", "-c", `cat "${join(home, ".ssh", "id_rsa")}" 2>&1; echo RAN`],
        { encoding: "utf-8", timeout: 10_000, stdio: ["ignore", "pipe", "pipe"] },
      );
      expect(out).toContain("RAN");
      expect(out).not.toContain("PRIVATE-KEY");
    } finally { rmSync(home, { recursive: true, force: true }); }
  });
});
