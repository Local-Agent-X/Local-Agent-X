/**
 * Spin up a project's dev server and wait for the ready URL to answer
 * a 2xx-or-similar. Returns a cleanup function that kills the server
 * process tree.
 *
 * The dev server runs as a child process in project_dir. We DON'T use
 * shell=true on non-Windows because that makes process-tree teardown
 * unreliable. We DO use shell=true on Windows because npm scripts only
 * work that way through node's spawn.
 *
 * Readiness check: poll the URL every 500ms until a connection succeeds
 * (status doesn't matter — many dev servers serve 200 or 304 once ready,
 * SPA shells often 200 with empty body during boot; any TCP-level reply
 * counts as "alive"). Hard timeout: launch.readyTimeoutMs.
 */

import { spawn, type ChildProcess } from "node:child_process";
import type { ProjectLaunchSpec } from "./types.js";

export interface LaunchedApp {
  proc: ChildProcess;
  stop: () => Promise<void>;
  stdout: string[];
  stderr: string[];
}

export async function launchApp(projectDir: string, launch: ProjectLaunchSpec, signal?: AbortSignal): Promise<LaunchedApp> {
  const isWin = process.platform === "win32";
  const stdout: string[] = [];
  const stderr: string[] = [];

  const [bin, ...args] = launch.start.split(/\s+/);
  const proc = spawn(bin, args, {
    cwd: projectDir,
    stdio: ["ignore", "pipe", "pipe"],
    shell: isWin, // npm/pnpm on Windows must be invoked through the shell
    env: { ...process.env, BROWSER: "none", FORCE_COLOR: "0" }, // BROWSER=none stops Vite/CRA from launching a tab
  });

  proc.stdout?.on("data", c => { stdout.push(c.toString()); if (stdout.length > 200) stdout.shift(); });
  proc.stderr?.on("data", c => { stderr.push(c.toString()); if (stderr.length > 200) stderr.shift(); });

  const stop = async (): Promise<void> => {
    if (proc.killed || proc.exitCode !== null) return;
    try {
      // On Windows, killing the npm process leaves the actual node dev
      // server orphaned. Use taskkill with /T to kill the whole tree.
      if (isWin && proc.pid) {
        await new Promise<void>((resolve) => {
          const tk = spawn("taskkill", ["/F", "/T", "/PID", String(proc.pid)], { shell: false });
          tk.on("close", () => resolve());
          tk.on("error", () => resolve());
        });
      } else {
        proc.kill("SIGTERM");
      }
    } catch { /* best-effort */ }
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
    if (await ping(launch.readyUrl)) {
      return { proc, stop, stdout, stderr };
    }
    await new Promise(r => setTimeout(r, 500));
  }

  await stop();
  throw new Error(`dev server did not become ready at ${launch.readyUrl} within ${launch.readyTimeoutMs}ms`);
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
