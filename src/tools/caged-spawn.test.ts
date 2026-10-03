// The caged-spawn seam: the order of its steps, the env every child gets, and
// the run-to-completion outcomes. The sandbox facade is modelled so the order
// is observable and no test reaches a real cage; the children are real node
// processes.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const REAL_PLATFORM = process.platform;

const seam = vi.hoisted(() => ({
  calls: [] as string[],
  proofPending: false,
  mode: "host" as "host" | "guarded",
  proxy: {} as Record<string, string>,
  wrapped: [] as Array<{ file: string; args: string[]; env: Record<string, string> }>,
  wrapTo: null as null | ((file: string, args: string[]) => { cmd: string; args: string[] }),
  home: null as string | null,
  grantsPending: false,
  grantFailure: null as string | null,
}));

// The profile the cage hides, so a test can place a program in one.
vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  return { ...actual, homedir: () => seam.home ?? actual.homedir() };
});

vi.mock("../sandbox/index.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../sandbox/index.js")>()),
  awaitSandboxProof: async (opts: { signal?: AbortSignal; onWait?: () => void } = {}) => {
    seam.calls.push("proof");
    if (seam.proofPending && opts.signal && !opts.signal.aborted) {
      opts.onWait?.();
      await new Promise((resolve) => opts.signal!.addEventListener("abort", resolve, { once: true }));
    }
  },
  getSandboxMode: () => seam.mode,
  // The grants the server makes in the background: still being made (until
  // the caller aborts), failed, or done.
  ensureWinCageGrants: async (file: string, signal?: AbortSignal) => {
    seam.calls.push(`grants:${file}`);
    if (seam.grantFailure) throw new Error(seam.grantFailure);
    if (seam.grantsPending && signal && !signal.aborted) await new Promise((resolve) => signal.addEventListener("abort", resolve, { once: true }));
  },
  wrapSpawnForSandbox: (file: string, args: string[], env: Record<string, string>) => {
    seam.calls.push("wrap");
    seam.wrapped.push({ file, args, env });
    return seam.wrapTo ? seam.wrapTo(file, args) : { cmd: file, args };
  },
}));
vi.mock("./shell-proxy-env.js", () => ({
  shellProxyEnv: async () => { seam.calls.push("proxy"); return seam.proxy; },
  shellProxyEnvSync: () => { seam.calls.push("proxy-sync"); return seam.proxy; },
}));
// Standing in for Windows on another host, the shell has to exist here.
vi.mock("./shell-env.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./shell-env.js")>();
  return { ...actual, resolveWindowsShell: () => (REAL_PLATFORM === "win32" ? actual.resolveWindowsShell() : { kind: "bash" as const, path: "/bin/bash" }) };
});

import { awaitCageReady, runCaged, spawnCaged, spawnCagedSync } from "./caged-spawn.js";
import { resolveWindowsShell } from "./shell-env.js";

const NODE = process.execPath;
const PRINT_ENV = { cmd: NODE, args: ["-e", "process.stdout.write(JSON.stringify(process.env))"] };
const setPlatform = (value: NodeJS.Platform): void => { Object.defineProperty(process, "platform", { value }); };
const isAlive = (pid: number): boolean => { try { process.kill(pid, 0); return true; } catch { return false; } };
async function until(check: () => boolean, ms = 8000): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) { if (check()) return true; await new Promise((r) => setTimeout(r, 50)); }
  return check();
}

const CREDENTIAL = "CAGED_SPAWN_TEST_API_KEY";
const PLAIN = "CAGED_SPAWN_TEST_PLAIN";

beforeEach(() => {
  seam.calls = [];
  seam.mode = "host";
  seam.proxy = {};
  seam.wrapped = [];
  seam.wrapTo = null;
  seam.proofPending = false;
  seam.home = null;
  seam.grantsPending = false;
  seam.grantFailure = null;
  process.env[CREDENTIAL] = "sk-live-0123456789abcdef";
  process.env[PLAIN] = "plain";
});
afterEach(() => {
  setPlatform(REAL_PLATFORM);
  delete process.env[CREDENTIAL];
  delete process.env[PLAIN];
});

describe("spawnCaged / runCaged: the seam", () => {
  it("waits for the proof, scrubs the env, grants, then wraps; the wrap and the child get one env", async () => {
    setPlatform("win32");
    seam.mode = "guarded";
    seam.proxy = { HTTP_PROXY: "http://lax:t@127.0.0.1:60090", NODE_USE_ENV_PROXY: "1" };
    seam.wrapTo = () => PRINT_ENV;
    const outcome = await runCaged("echo hi", { cwd: tmpdir(), env: { EXTRA: "1", HTTP_PROXY: "http://caller" }, timeoutMs: 15_000 });

    expect(seam.calls).toEqual(["proof", "proxy", `grants:${resolveWindowsShell().path}`, "wrap"]);
    expect(outcome).toMatchObject({ kind: "exit", code: 0, sandboxMode: "guarded" });
    const childEnv = JSON.parse(outcome.kind === "exit" ? outcome.stdout : "{}") as Record<string, string>;
    const wrapEnv = seam.wrapped[0].env;
    for (const env of [childEnv, wrapEnv]) {
      expect(env.EXTRA).toBe("1");
      expect(env.HTTP_PROXY).toBe("http://caller");
      expect(env.NODE_USE_ENV_PROXY).toBe("1");
      expect(env[PLAIN]).toBe("plain");
      expect(env.GIT_TERMINAL_PROMPT).toBe("0");
      expect(env[CREDENTIAL]).toBeUndefined();
    }
  });

  it("runs a command line through the platform shell the way bash does", async () => {
    await runCaged("echo hi", { cwd: tmpdir(), timeoutMs: 15_000 }).catch(() => undefined);
    const { file, args } = seam.wrapped[0];
    if (REAL_PLATFORM !== "win32") expect({ file, args }).toEqual({ file: "/bin/bash", args: ["-c", "echo hi"] });
    else {
      const shell = resolveWindowsShell();
      expect({ file, args }).toEqual({ file: shell.path, args: shell.kind === "bash" ? ["-c", "echo hi"] : ["-NoProfile", "-Command", "echo hi"] });
    }
  });

  it("an abort during the proof wait starts nothing", async () => {
    seam.proofPending = true;
    const controller = new AbortController();
    const waited: string[] = [];
    const run = runCaged({ file: NODE, args: ["-e", ""] }, { cwd: tmpdir(), timeoutMs: 15_000, signal: controller.signal, onWait: () => waited.push("wait") });
    await new Promise((r) => setTimeout(r, 20));
    controller.abort();
    expect(await run).toMatchObject({ kind: "abort" });
    expect(waited).toEqual(["wait"]);
    expect(seam.calls).toEqual(["proof"]);
    await expect(spawnCaged({ file: NODE, args: [] }, { cwd: tmpdir(), signal: controller.signal })).rejects.toThrow();
    expect(seam.calls).toEqual(["proof", "proof"]);
  });

  it("a refused wrap rejects and starts nothing", async () => {
    seam.wrapTo = () => { throw new Error("still being verified"); };
    await expect(runCaged("echo hi", { cwd: tmpdir(), timeoutMs: 15_000 })).rejects.toThrow("still being verified");
    expect(() => spawnCagedSync("echo hi", { cwd: tmpdir() })).toThrow("still being verified");
  });

  // The grants are made in the background once the proof lands; a spawn that
  // can wait joins them rather than reaching the wrap, which would refuse.
  it("under the Windows cage, a command waits for the grants; an abort meanwhile starts nothing", async () => {
    setPlatform("win32");
    seam.mode = "guarded";
    seam.grantsPending = true;
    const controller = new AbortController();
    const run = runCaged("echo hi", { cwd: tmpdir(), timeoutMs: 15_000, signal: controller.signal });
    await new Promise((r) => setTimeout(r, 20));
    expect(seam.calls).toEqual(["proof", "proxy", `grants:${resolveWindowsShell().path}`]);
    controller.abort();
    expect(await run).toMatchObject({ kind: "abort" });
    expect(seam.wrapped).toEqual([]);
  });

  it("under the Windows cage, failed grants reject and start nothing", async () => {
    setPlatform("win32");
    seam.mode = "guarded";
    seam.grantFailure = "the Windows shell cage could not give its sandbox user access";
    await expect(runCaged("echo hi", { cwd: tmpdir(), timeoutMs: 15_000 })).rejects.toThrow(seam.grantFailure);
    expect(seam.wrapped).toEqual([]);
  });
});

// process_start and process_restart start through spawnCagedSync, which
// cannot wait, so they wait here first.
describe("awaitCageReady", () => {
  it("under the Windows cage, waits for the proof and then the trusted shell's grants", async () => {
    setPlatform("win32");
    seam.mode = "guarded";
    await awaitCageReady();
    expect(seam.calls).toEqual(["proof", `grants:${resolveWindowsShell().path}`]);
  });

  it("off the Windows cage, waits for the proof only", async () => {
    setPlatform("win32");
    await awaitCageReady();
    expect(seam.calls).toEqual(["proof"]);
  });

  it("passes on a grant failure, so the caller refuses before it stops or starts anything", async () => {
    setPlatform("win32");
    seam.mode = "guarded";
    seam.grantFailure = "the Windows shell cage could not give its sandbox user access";
    await expect(awaitCageReady()).rejects.toThrow(seam.grantFailure);
  });

  it("an abort during the proof wait skips the grants", async () => {
    setPlatform("win32");
    seam.mode = "guarded";
    seam.proofPending = true;
    const controller = new AbortController();
    const ready = awaitCageReady(controller.signal);
    await new Promise((r) => setTimeout(r, 20));
    controller.abort();
    await ready;
    expect(seam.calls).toEqual(["proof"]);
  });
});

describe("the argv form", () => {
  it("runs the program with its argv and no shell in between", async () => {
    const arg = "a b; echo $HOME && exit 3";
    const outcome = await runCaged({ file: NODE, args: ["-e", "process.stdout.write(process.argv[1])", arg] }, { cwd: tmpdir(), timeoutMs: 15_000 });
    expect(outcome).toMatchObject({ kind: "exit", code: 0, stdout: arg });
  });

  // The Windows cage's helper starts a program by path only, so a bare name is
  // resolved first, and the grants are always the trusted shell's: a grant
  // outlives the command and every later command shares it.
  it("under the Windows cage, a name not on the PATH starts nothing and grants nothing", async () => {
    setPlatform("win32");
    seam.mode = "guarded";
    await expect(runCaged({ file: "no-such-program-caged-spawn", args: [] }, { cwd: tmpdir(), timeoutMs: 15_000 }))
      .rejects.toThrow('"no-such-program-caged-spawn" was not found on the PATH, so nothing was started.');
    expect(seam.calls).toEqual(["proof", "proxy"]);
  });

  it("under the Windows cage, a program path that is not a file starts nothing and grants nothing", async () => {
    setPlatform("win32");
    seam.mode = "guarded";
    const missing = join(tmpdir(), "no-such-dir-caged-spawn", "tool.exe");
    await expect(runCaged({ file: missing, args: [] }, { cwd: tmpdir(), timeoutMs: 15_000 }))
      .rejects.toThrow(`"${missing}" was not found, so nothing was started.`);
    expect(seam.calls).toEqual(["proof", "proxy"]);
  });

  it.skipIf(REAL_PLATFORM !== "win32")("under the Windows cage, a bare name is resolved on the PATH and the grant is the shell's", async () => {
    seam.mode = "guarded";
    const outcome = await runCaged({ file: "node", args: ["-e", "process.stdout.write('ran')"] }, { cwd: tmpdir(), timeoutMs: 15_000 });
    expect(seam.wrapped[0].file).toMatch(/^[a-z]:\\.*\\node\.exe$/i);
    expect(seam.calls).toEqual(["proof", "proxy", `grants:${resolveWindowsShell().path}`, "wrap"]);
    expect(outcome).toMatchObject({ kind: "exit", code: 0, stdout: "ran" });
  });

  // A relative entry resolves against the server's own cwd, which is not
  // where a program should come from (here: the repo, beside vitest's config).
  it.skipIf(REAL_PLATFORM !== "win32")("under the Windows cage, a relative PATH entry is never searched", async () => {
    seam.mode = "guarded";
    await expect(runCaged({ file: "vitest.config.ts", args: [] }, { cwd: tmpdir(), env: { PATH: "." }, timeoutMs: 15_000 }))
      .rejects.toThrow('"vitest.config.ts" was not found on the PATH, so nothing was started.');
    expect(seam.calls).toEqual(["proof", "proxy"]);
  });

  // The wrap grants read on its program's install root, one level above a
  // `bin` folder: run from `<profile>\bin`, that root is the whole profile.
  // So such a program must never reach the wrap, nor any grant.
  it.skipIf(REAL_PLATFORM !== "win32")("under the Windows cage, a program in the profile outside the shell's roots is refused before any grant", async () => {
    const home = mkdtempSync(join(tmpdir(), "caged-spawn-home-"));
    try {
      mkdirSync(join(home, "bin"));
      const program = join(home, "bin", "tool.exe");
      writeFileSync(program, "");
      seam.mode = "guarded";
      seam.home = home;
      const refusal = `"${program}" is in your user profile, outside the folders the shell cage may read, so nothing was started.`;
      await expect(runCaged({ file: program, args: [] }, { cwd: tmpdir(), timeoutMs: 15_000 })).rejects.toThrow(refusal);
      await expect(runCaged({ file: "tool", args: [] }, { cwd: tmpdir(), env: { PATH: join(home, "bin") }, timeoutMs: 15_000 })).rejects.toThrow(refusal);
      expect(() => spawnCagedSync({ file: program, args: [] }, { cwd: tmpdir() })).toThrow(refusal);
      expect(seam.calls).toEqual(["proof", "proxy", "proof", "proxy", "proxy-sync"]);
      expect(seam.wrapped).toEqual([]);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it.skipIf(REAL_PLATFORM !== "win32")("under the Windows cage, a program in the profile inside a root the shell's grants cover runs", async () => {
    seam.mode = "guarded";
    seam.home = dirname(NODE);
    const outcome = await runCaged({ file: NODE, args: ["-e", "process.stdout.write('ran')"] }, { cwd: tmpdir(), timeoutMs: 15_000 });
    expect(outcome).toMatchObject({ kind: "exit", code: 0, stdout: "ran" });
    expect(seam.calls).toEqual(["proof", "proxy", `grants:${resolveWindowsShell().path}`, "wrap"]);
  });

  it("off the Windows cage, the program is spawned as given", async () => {
    seam.mode = "host";
    await runCaged({ file: "no-such-program-caged-spawn", args: [] }, { cwd: tmpdir(), timeoutMs: 15_000 }).catch(() => undefined);
    expect(seam.wrapped[0].file).toBe("no-such-program-caged-spawn");
  });
});

describe("runCaged outcomes", () => {
  const LIVE = "process.stdout.write(String(process.pid)); setInterval(() => {}, 1000)";

  it("a timeout kills the process and resolves with what it printed", async () => {
    const outcome = await runCaged({ file: NODE, args: ["-e", LIVE] }, { cwd: tmpdir(), timeoutMs: 4000 });
    expect(outcome.kind).toBe("timeout");
    const pid = Number(outcome.kind === "timeout" ? outcome.stdout : NaN);
    expect(pid).toBeGreaterThan(0);
    expect(await until(() => !isAlive(pid))).toBe(true);
  }, 20_000);

  it("an abort while running kills the process", async () => {
    const controller = new AbortController();
    let pid = 0;
    const outcome = await runCaged({ file: NODE, args: ["-e", LIVE] }, {
      cwd: tmpdir(), timeoutMs: 15_000, signal: controller.signal,
      onOutput: (out) => { pid = Number(out.stdout); controller.abort(); },
    });
    expect(outcome.kind).toBe("abort");
    expect(pid).toBeGreaterThan(0);
    expect(await until(() => !isAlive(pid))).toBe(true);
  }, 20_000);

  // A child that leaves a background process holding its stdout. Detached:
  // on Windows a node child otherwise sits in a kill-on-close job and dies
  // with its parent.
  const LEAVES_HOLDER = (lifeMs: number): string[] => ["-e",
    `const c = require("node:child_process").spawn(process.execPath, ["-e", "setTimeout(() => {}, ${lifeMs})"], { stdio: "inherit", detached: true });` +
    "process.stdout.write(String(c.pid)); c.unref();"];

  it("settleOn exit returns when the process exits, while a background holder keeps the pipes open", async () => {
    const outcome = await runCaged({ file: NODE, args: LEAVES_HOLDER(30_000) }, { cwd: tmpdir(), timeoutMs: 15_000, settleOn: "exit" });
    expect(outcome).toMatchObject({ kind: "exit", code: 0 });
    const holder = Number(outcome.kind === "exit" ? outcome.stdout : NaN);
    try {
      expect(isAlive(holder)).toBe(true);
    } finally {
      try { process.kill(holder); } catch { /* already gone */ }
    }
  }, 20_000);

  // The holder starts after the run does and lives 1000 ms, so a run that
  // waited for it cannot have taken less.
  it("by default it settles once the output has ended, after the holder is gone", async () => {
    const outcome = await runCaged({ file: NODE, args: LEAVES_HOLDER(1000) }, { cwd: tmpdir(), timeoutMs: 15_000 });
    expect(outcome).toMatchObject({ kind: "exit", code: 0 });
    expect(outcome.durationMs).toBeGreaterThanOrEqual(1000);
  }, 20_000);
});

describe("spawnCagedSync", () => {
  it("composes the same scrubbed env from the live proxy route, without waiting", async () => {
    seam.proxy = { HTTP_PROXY: "http://lax:t@127.0.0.1:60090" };
    seam.wrapTo = () => PRINT_ENV;
    const child = spawnCagedSync("echo hi", { cwd: tmpdir(), env: { EXTRA: "1" } });
    let out = "";
    child.stdout.setEncoding("utf-8");
    child.stdout.on("data", (c: string) => { out += c; });
    await new Promise((r) => child.on("close", r));
    const env = JSON.parse(out) as Record<string, string>;
    expect(seam.calls).toEqual(["proxy-sync", "wrap"]);
    expect(env).toMatchObject({ EXTRA: "1", HTTP_PROXY: "http://lax:t@127.0.0.1:60090", [PLAIN]: "plain", GIT_TERMINAL_PROMPT: "0" });
    expect(env[CREDENTIAL]).toBeUndefined();
  });
});
