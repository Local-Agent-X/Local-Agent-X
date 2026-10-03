/**
 * Spin up a project's dev server and wait for the ready URL to answer
 * a 2xx-or-similar. Returns a cleanup function that kills the server
 * process tree.
 *
 * The start line is the agent's own (`.lax-launch.json`: `pnpm dev`,
 * `vite --port $PORT`), so it runs the way process_start runs one: vetted by
 * the shell policy, then through the platform shell in the shell cage, on the
 * scrubbed env, leading its own process group on POSIX so teardown reaches
 * the server npm starts.
 *
 * Readiness check: poll the URL every 500ms until a connection succeeds
 * (status doesn't matter — many dev servers serve 200 or 304 once ready,
 * SPA shells often 200 with empty body during boot; any TCP-level reply
 * counts as "alive"). Hard timeout: launch.readyTimeoutMs.
 */

import type { ChildProcess } from "node:child_process";
import { killProcessGroup } from "../../process-tree-kill.js";
import { getSandboxStatus } from "../../sandbox/index.js";
import { evaluateShellCommand } from "../../security/layer/index.js";
import { spawnCaged } from "../../tools/caged-spawn.js";
import { registerOwnedProcess, unregisterOwnedProcess } from "../../tools/owned-listeners.js";
import { allocatePort } from "./port-alloc.js";
import type { ProjectLaunchSpec } from "./types.js";

export interface LaunchedApp {
  proc: ChildProcess;
  stop: () => Promise<void>;
  stdout: string[];
  stderr: string[];
  /** The url the server was actually pointed at (allocated port). Poll/score THIS. */
  url: string;
}

/**
 * @param workerIndex 0 (default) is the serial single-build path and is
 *   byte-identical to before: base port, no PORT injected, base url polled.
 *   A parallel worker N>0 gets a distinct port (base + N): the port is
 *   injected as `PORT` into the child env and the rewritten url is polled.
 */
export async function launchApp(projectDir: string, launch: ProjectLaunchSpec, signal?: AbortSignal, workerIndex = 0): Promise<LaunchedApp> {
  const stdout: string[] = [];
  const stderr: string[] = [];

  // Which port does THIS worker own? Worker 0 → base port, url unchanged.
  const { port, url } = allocatePort(launch.readyUrl, workerIndex);

  const verdict = evaluateShellCommand(launch.start, undefined, undefined, undefined, undefined, getSandboxStatus().confined);
  if (!verdict.allowed) throw new Error(`blocked by shell policy: ${verdict.reason}`);

  // BROWSER=none stops Vite/CRA from launching a tab.
  const env: Record<string, string> = { BROWSER: "none", FORCE_COLOR: "0" };
  // Only a parallel worker overrides the port, so worker 0's env stays
  // byte-identical (no PORT set → the project's own default or an inherited
  // PORT is untouched). PORT is the framework-agnostic lever: Next/CRA/Remix
  // and most Node dev servers honor it. LIMITATION: a dev server that ignores
  // PORT (e.g. Vite without `--port`/config) will NOT move — the project's
  // `.lax-launch.json` `start` command must honor $PORT (e.g. "vite --port
  // $PORT") for parallel scoring to be collision-free. Over-allocating a port
  // the server ignores is a documented gap, not a silent success.
  if (workerIndex > 0) env.PORT = String(port);

  const proc = await spawnCaged(launch.start, { cwd: projectDir, env, detached: process.platform !== "win32", signal });
  // While it runs, the port the app listens on is admitted to the cage and to
  // the agent's HTTP tools, as a process_start dev server's is.
  registerOwnedProcess(proc.pid);
  proc.on("exit", () => unregisterOwnedProcess(proc.pid));

  proc.stdout.on("data", c => { stdout.push(c.toString()); if (stdout.length > 200) stdout.shift(); });
  proc.stderr.on("data", c => { stderr.push(c.toString()); if (stderr.length > 200) stderr.shift(); });

  const stop = async (): Promise<void> => {
    if (proc.killed || proc.exitCode !== null) return;
    // The whole tree: npm wraps the real node dev server, which killing the
    // shell alone would orphan.
    if (proc.pid) killProcessGroup(proc.pid, proc);
  };

  signal?.addEventListener("abort", () => { void stop(); });

  // Poll the ready URL until it answers or we time out.
  const deadline = Date.now() + launch.readyTimeoutMs;
  while (Date.now() < deadline) {
    if (signal?.aborted) { await stop(); throw new Error("app launch aborted"); }
    if (proc.exitCode !== null) {
      await stop();
      throw new Error(`dev server exited before ready (code=${proc.exitCode}): ${stderr.slice(-3).join("").slice(0, 500)}`);
    }
    if (await ping(url)) {
      return { proc, stop, stdout, stderr, url };
    }
    await new Promise(r => setTimeout(r, 500));
  }

  await stop();
  throw new Error(`dev server did not become ready at ${url} within ${launch.readyTimeoutMs}ms`);
}

async function ping(url: string): Promise<boolean> {
  try {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), 1500);
    const res = await fetch(url, { signal: ac.signal, redirect: "manual" });
    clearTimeout(timer);
    // Any HTTP response means the port is alive, even 3xx/4xx.
    return res.status > 0;
  } catch {
    return false;
  }
}
