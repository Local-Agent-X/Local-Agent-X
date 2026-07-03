/**
 * R6-A4: the startup "Open" line must never carry the auth token into stdout.
 *
 * The token is hidden inside an OSC-8 hyperlink escape, so the leak is
 * invisible to the eye — this guard fails loudly if a future edit puts the
 * token back into either the link target or the visible text.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join, resolve, relative, sep } from "node:path";

// Stub the teardown collaborators registerShutdown reaches for so the graceful
// path runs deterministically without spinning up browsers/dev-servers/etc.
vi.mock("../browser/index.js", () => ({ closeAllBrowsers: vi.fn(async () => {}) }));
vi.mock("../tools/dev-server.js", () => ({ stopAllDevServers: vi.fn() }));
vi.mock("../agents/watchdog.js", () => ({ WatchdogService: { getInstance: () => ({ stop: vi.fn() }) } }));
vi.mock("../broker-transport/account/runtime.js", () => ({ stopBrokerPresence: vi.fn() }));
vi.mock("../agency/worktree.js", () => ({ cleanupAllWorktrees: vi.fn() }));

import { buildOpenLine, registerShutdown, installBootSignalFallback } from "./lifecycle.js";

describe("buildOpenLine (R6-A4)", () => {
  it("emits no token — neither in the OSC-8 link target nor the visible text", () => {
    const line = buildOpenLine(8787, "/home/u/.lax/.startup-url");
    expect(line).not.toContain("token");
    expect(line).not.toContain("?");
  });

  it("still links to the loopback app origin and points at the sign-in URL file", () => {
    const line = buildOpenLine(8787, "/home/u/.lax/.startup-url");
    expect(line).toContain("http://127.0.0.1:8787/");
    expect(line).toContain("/home/u/.lax/.startup-url");
  });
});

// SV-2: graceful shutdown was dead code — an earlier synchronous
// process.exit() SIGINT handler in lifecycle.ts preempted this cleanup, and
// SIGTERM had no graceful handler at all. registerShutdown must own graceful
// teardown for BOTH signals and actually run the cleanup before exiting.
describe("registerShutdown graceful teardown (SV-2)", () => {
  const added: Array<{ sig: "SIGINT" | "SIGTERM"; fn: (...a: unknown[]) => void }> = [];

  function makeDeps() {
    return {
      getScheduler: () => ({ stopAll: vi.fn() }) as unknown as import("./scheduler.js").JobScheduler,
      cronService: { stop: vi.fn() } as unknown as import("../cron/cron-service.js").CronService,
      agentSync: { stopHeartbeat: vi.fn(), push: vi.fn(async () => {}) } as unknown as import("../sync/index.js").AgentSync,
      memoryIndex: { close: vi.fn() } as unknown as import("../memory/index.js").MemoryIndex,
      secretsStore: { destroy: vi.fn() } as unknown as import("../secrets.js").SecretsStore,
    };
  }

  // Track only the listeners registerShutdown itself installs, so we can
  // invoke and later remove exactly those (never vitest's own handlers).
  function register(deps: Parameters<typeof registerShutdown>[0]) {
    const before = {
      SIGINT: new Set(process.listeners("SIGINT")),
      SIGTERM: new Set(process.listeners("SIGTERM")),
    };
    registerShutdown(deps);
    const pick = (sig: "SIGINT" | "SIGTERM") =>
      (process.listeners(sig) as Array<(...a: unknown[]) => void>).filter((l) => !before[sig].has(l));
    const sigint = pick("SIGINT");
    const sigterm = pick("SIGTERM");
    for (const fn of sigint) added.push({ sig: "SIGINT", fn });
    for (const fn of sigterm) added.push({ sig: "SIGTERM", fn });
    return { sigint, sigterm };
  }

  afterEach(() => {
    for (const { sig, fn } of added) process.removeListener(sig, fn);
    added.length = 0;
    vi.restoreAllMocks();
  });

  it("registers a graceful handler for BOTH SIGINT and SIGTERM", () => {
    const { sigint, sigterm } = register(makeDeps());
    expect(sigint).toHaveLength(1);
    // Pre-fix this was 0 — SIGTERM had no graceful handler at all.
    expect(sigterm).toHaveLength(1);
  });

  it("runs the full async cleanup (memory push, index close, secrets) on SIGTERM before exit", async () => {
    const deps = makeDeps();
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(((_c?: number) => {
      // Don't actually kill the test runner; record the call instead.
      return undefined as never;
    }) as never);

    const { sigterm } = register(deps);
    sigterm[0]("SIGTERM");

    await vi.waitFor(() => expect(exitSpy).toHaveBeenCalledWith(0));
    expect(deps.agentSync.push).toHaveBeenCalled();
    expect(deps.memoryIndex.close).toHaveBeenCalled();
    expect(deps.secretsStore.destroy).toHaveBeenCalled();
    expect(deps.cronService.stop).toHaveBeenCalled();
  });
});

// SV-2 class-lock: registerShutdown's cleanup is async, and Node fires signal
// listeners synchronously in registration order — so ANY sibling handler that
// calls process.exit() synchronously (whenever it was registered: at boot like
// src/lifecycle.ts, or at runtime like src/autopilot/lock.ts used to) kills
// the process the moment the graceful handler suspends at its first `await`,
// orphaning dev-servers/Chrome/worktrees and dropping the last memory push.
// The invariant: src/server/lifecycle.ts is the ONLY module allowed to call
// process.exit from a SIGINT/SIGTERM handler. Everyone else hooks the
// signal-agnostic 'exit' event for synchronous cleanup.
describe("signal-handler exit ownership (SV-2 class-lock)", () => {
  const SRC_ROOT = resolve(__dirname, "..");
  const CANONICAL = ["server", "lifecycle.ts"].join(sep);
  const SIG_REGISTRATION = /process\.(?:on|once)\(\s*["']SIG(?:INT|TERM)["']/g;

  function sourceFiles(dir: string): string[] {
    const out: string[] = [];
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, entry.name);
      if (entry.isDirectory()) out.push(...sourceFiles(p));
      else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts")) out.push(p);
    }
    return out;
  }

  it("no module other than server/lifecycle.ts exits synchronously from a SIGINT/SIGTERM handler", () => {
    const offenders: string[] = [];
    for (const file of sourceFiles(SRC_ROOT)) {
      const rel = relative(SRC_ROOT, file);
      if (rel === CANONICAL) continue; // the one canonical graceful-shutdown owner
      const src = readFileSync(file, "utf-8");
      for (const match of src.matchAll(SIG_REGISTRATION)) {
        // Look at the handler body following the registration. A process.exit
        // that appears before any `await` runs synchronously inside the signal
        // dispatch and preempts the canonical async shutdown.
        const window = src.slice(match.index, match.index + 500);
        const exitAt = window.indexOf("process.exit");
        if (exitAt === -1) continue; // non-exiting hook (log flush etc.) — fine
        const awaitAt = window.indexOf("await");
        if (awaitAt === -1 || exitAt < awaitAt) offenders.push(`${rel} @ char ${match.index}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("the two known former offenders register no signal handlers at all", () => {
    for (const rel of ["lifecycle.ts", join("autopilot", "lock.ts")]) {
      const src = readFileSync(join(SRC_ROOT, rel), "utf-8");
      expect(src.match(SIG_REGISTRATION) ?? [], `${rel} must ride the 'exit' event, not signals`).toEqual([]);
    }
  });
});

// SV-2 addendum: during the boot window (before registerShutdown runs) the
// only signal listeners are non-exiting log-flush hooks, and any listener
// suppresses Node's default terminate — so a fallback must hard-exit, and the
// graceful owner must retire it at handoff (or it would preempt the async
// cleanup exactly like the pre-SV-2 handlers).
describe("boot-window signal fallback (SV-2)", () => {
  it("fallback hard-exits during boot and is retired by registerShutdown", async () => {
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(((_c?: number) => undefined as never) as never);
    const before = {
      SIGINT: new Set(process.listeners("SIGINT")),
      SIGTERM: new Set(process.listeners("SIGTERM")),
    };
    installBootSignalFallback();
    const pick = (sig: "SIGINT" | "SIGTERM") =>
      (process.listeners(sig) as Array<() => void>).filter((l) => !before[sig].has(l));
    const bootInt = pick("SIGINT");
    const bootTerm = pick("SIGTERM");
    try {
      expect(bootInt).toHaveLength(1);
      expect(bootTerm).toHaveLength(1);
      // Boot-window Ctrl+C actually terminates (pre-fix: swallowed by the
      // log-flush listeners, process unkillable short of SIGKILL).
      bootInt[0]();
      expect(exitSpy).toHaveBeenCalledWith(130);
      bootTerm[0]();
      expect(exitSpy).toHaveBeenCalledWith(143);
      // Handoff: the graceful owner retires the fallback so it can never
      // preempt the async cleanup.
      registerShutdown({
        getScheduler: () => ({ stopAll: vi.fn() }) as unknown as import("./scheduler.js").JobScheduler,
        cronService: { stop: vi.fn() } as unknown as import("../cron/cron-service.js").CronService,
        agentSync: { stopHeartbeat: vi.fn(), push: vi.fn(async () => {}) } as unknown as import("../sync/index.js").AgentSync,
        memoryIndex: { close: vi.fn() } as unknown as import("../memory/index.js").MemoryIndex,
        secretsStore: { destroy: vi.fn() } as unknown as import("../secrets.js").SecretsStore,
      });
      expect(process.listeners("SIGINT")).not.toContain(bootInt[0]);
      expect(process.listeners("SIGTERM")).not.toContain(bootTerm[0]);
    } finally {
      for (const sig of ["SIGINT", "SIGTERM"] as const) {
        for (const l of process.listeners(sig)) {
          if (!before[sig].has(l as () => void)) process.removeListener(sig, l as () => void);
        }
      }
      vi.restoreAllMocks();
    }
  });
});
