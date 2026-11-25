// The scenario scorer's dev server runs the agent's start line, so it goes
// through the shell policy and the caged-spawn seam. The sandbox facade is
// modelled so the wrap is observable and no test reaches a real cage; the dev
// server that runs in place of the shell is a real node HTTP server.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

const seam = vi.hoisted(() => ({
  proofPending: false,
  mode: "host" as "host" | "guarded",
  // The Windows grants the server makes in the background: settled by the test.
  grants: Promise.resolve(),
  grantsAsked: 0,
  wrapped: [] as Array<{ file: string; args: string[]; env: Record<string, string> }>,
  owned: [] as string[],
}));
vi.mock("../../sandbox/index.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../sandbox/index.js")>();
  return {
    ...actual,
    awaitSandboxProof: async () => {},
    getSandboxMode: () => seam.mode,
    ensureWinCageGrants: async () => { seam.grantsAsked++; await seam.grants; },
    getSandboxStatus: () => ({ confined: false, proofPending: seam.proofPending }),
    wrapSpawnForSandbox: (file: string, args: string[], env: Record<string, string>) => {
      if (seam.proofPending) throw new actual.SandboxProofPendingError();
      seam.wrapped.push({ file, args, env });
      return { cmd: process.execPath, args: ["-e", SERVES_ITS_ENV] };
    },
  };
});
vi.mock("../../tools/shell-proxy-env.js", () => ({ shellProxyEnv: async () => ({}), shellProxyEnvSync: () => ({}) }));
vi.mock("../../tools/owned-listeners.js", () => ({
  registerOwnedProcess: (pid: number) => { seam.owned.push(`+${pid}`); },
  unregisterOwnedProcess: (pid: number) => { seam.owned.push(`-${pid}`); },
}));

// Serves its own env as JSON on $PORT, the way `vite --port $PORT` would serve the app.
const SERVES_ITS_ENV = "require('http').createServer((q, s) => s.end(JSON.stringify(process.env))).listen(Number(process.env.PORT), '127.0.0.1')";

import { launchApp } from "./app-launcher.js";
import { SANDBOX_PROOF_PENDING_RETRY } from "../../sandbox/index.js";
import { resolveWindowsShell } from "../../tools/shell-env.js";

const CREDENTIAL = "APP_LAUNCHER_TEST_API_KEY";
const REAL_PLATFORM = process.platform;

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as { port: number };
  await new Promise((resolve) => server.close(resolve));
  return port;
}

async function until(check: () => boolean, ms = 8000): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) { if (check()) return true; await new Promise((r) => setTimeout(r, 50)); }
  return check();
}

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "app-launcher-"));
  seam.proofPending = false;
  seam.mode = "host";
  seam.grants = Promise.resolve();
  seam.grantsAsked = 0;
  seam.wrapped = [];
  seam.owned = [];
  process.env[CREDENTIAL] = "sk-live-0123456789abcdef";
});
afterEach(() => {
  Object.defineProperty(process, "platform", { value: REAL_PLATFORM });
  delete process.env[CREDENTIAL];
  rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

describe("launchApp", () => {
  it("runs the start line through the platform shell in the cage, on the scrubbed env, and admits its port", async () => {
    // Worker 1 is moved one port up through $PORT.
    const port = await freePort();
    const launch = { start: "npm run dev", readyUrl: `http://127.0.0.1:${port - 1}/`, readyTimeoutMs: 15_000 };
    const app = await launchApp(dir, launch, undefined, 1);
    try {
      expect(app.url).toBe(`http://127.0.0.1:${port}/`);
      const served = await (await fetch(app.url)).json() as Record<string, string>;
      expect(served).toMatchObject({ BROWSER: "none", PORT: String(port) });
      expect(served[CREDENTIAL]).toBeUndefined();

      const { file, args } = seam.wrapped[0];
      if (process.platform !== "win32") expect({ file, args }).toEqual({ file: "/bin/bash", args: ["-c", "npm run dev"] });
      else {
        const shell = resolveWindowsShell();
        expect({ file, args }).toEqual({ file: shell.path, args: shell.kind === "bash" ? ["-c", "npm run dev"] : ["-NoProfile", "-Command", "npm run dev"] });
      }
      expect(seam.owned).toEqual([`+${app.proc.pid}`]);
    } finally {
      await app.stop();
    }
    expect(await until(() => seam.owned.length === 2)).toBe(true);
    expect(seam.owned[1]).toBe(`-${app.proc.pid}`);
  }, 20_000);

  it("fails closed while the Windows cage proof is pending: nothing starts", async () => {
    seam.proofPending = true;
    const launch = { start: "npm run dev", readyUrl: `http://127.0.0.1:${await freePort()}/`, readyTimeoutMs: 15_000 };
    await expect(launchApp(dir, launch)).rejects.toThrow(SANDBOX_PROOF_PENDING_RETRY);
    expect(seam.wrapped).toEqual([]);
    expect(seam.owned).toEqual([]);
  });

  // The first build scored after a restart can arrive while the sandbox user
  // is still being granted the workspace: the launcher waits for that grant
  // rather than making one itself, and a failed grant starts nothing.
  it("under the Windows cage, waits for the sandbox user's grants; a failed grant starts nothing", async () => {
    Object.defineProperty(process, "platform", { value: "win32" });
    seam.mode = "guarded";
    let fail!: (e: Error) => void;
    seam.grants = new Promise<void>((_, reject) => { fail = reject; });
    const launch = { start: "npm run dev", readyUrl: `http://127.0.0.1:${await freePort()}/`, readyTimeoutMs: 15_000 };
    const launching = launchApp(dir, launch);
    await new Promise((r) => setTimeout(r, 30));
    expect(seam.grantsAsked).toBe(1);
    expect(seam.wrapped).toEqual([]);
    fail(new Error("The Windows shell cage could not give its sandbox user access to the workspace"));
    await expect(launching).rejects.toThrow("could not give its sandbox user access");
    expect(seam.wrapped).toEqual([]);
    expect(seam.owned).toEqual([]);
  });

  it("refuses to score a server it did not start: nothing is spawned while the port answers", async () => {
    const other = (await import("node:http")).createServer((_q, s) => s.end("someone else's app"));
    const port = await freePort();
    await new Promise<void>((resolve) => other.listen(port, "127.0.0.1", resolve));
    try {
      const launch = { start: "npm run dev", readyUrl: `http://127.0.0.1:${port}/`, readyTimeoutMs: 15_000 };
      await expect(launchApp(dir, launch)).rejects.toThrow(/already answering at http:\/\/127\.0\.0\.1:\d+\/, so the judge would score it/);
      expect(seam.wrapped).toEqual([]);
    } finally {
      await new Promise((resolve) => other.close(resolve));
    }
  });

  it("starts the app with its launch file's test-mode settings, under the launcher's own", async () => {
    const port = await freePort();
    const launch = { start: "npm run dev", readyUrl: `http://127.0.0.1:${port - 1}/`, readyTimeoutMs: 15_000, env: { EXPO_PUBLIC_TWIN: "1", BROWSER: "chrome" } };
    const app = await launchApp(dir, launch, undefined, 1);
    try {
      const served = await (await fetch(app.url)).json() as Record<string, string>;
      expect(served).toMatchObject({ EXPO_PUBLIC_TWIN: "1", BROWSER: "none" });
    } finally {
      await app.stop();
    }
    // A stop returns once the app is gone: the next start on this port must
    // not find it still answering.
    await expect(fetch(app.url)).rejects.toThrow();
    // Its exit, before the folder it ran in is removed.
    expect(await until(() => seam.owned.length === 2)).toBe(true);
  }, 20_000);

  it("a start line the shell policy refuses never reaches the cage", async () => {
    const launch = { start: "npm run dev -- --token {{API_TOKEN}}", readyUrl: "http://127.0.0.1:5173/", readyTimeoutMs: 15_000 };
    await expect(launchApp(dir, launch)).rejects.toThrow(/^blocked by shell policy: /);
    expect(seam.wrapped).toEqual([]);
  });
});
