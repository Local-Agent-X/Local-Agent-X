/**
 * The one way to start a process under the shell cage.
 *
 * The seam is five steps, and their order is what keeps a command inside the
 * cage: a step skipped or run out of order starts the command unconfined, or
 * caged but with no route out, or refused. So callers never compose it:
 *
 *   1. wait, bounded, for a Windows fence proof still running, so the command
 *      runs under the settled answer instead of being refused (async only);
 *   2. scrub the env (buildSanitizedEnv) and lay the egress-proxy route and
 *      the caller's vars over it, never the raw process.env;
 *   3. on the Windows cage, wait for the sandbox user's grants: read on the
 *      shell's install root and the node runtime when they sit under the
 *      user's profile, write on the workspace (which covers a cwd inside it).
 *      The server makes them in the background once the proof lands, never on
 *      a spawn (win-cage-grants.ts). Keyed on the trusted shell for both spec
 *      forms, never on a caller's program: a grant lasts as long as the server
 *      and every later command shares it;
 *   4. wrap the program for the active cage (wrapSpawnForSandbox), which
 *      refuses while a proof or the grants are still pending;
 *   5. spawn with the same env the wrap was given.
 *
 * Lives in tools/, beside the env and shell pieces it composes: the sandbox
 * facade is the layer below them (shell-proxy-env imports it), so composing
 * there would import upward into tools/ and close a cycle.
 */
import { spawn, type ChildProcessByStdio } from "node:child_process";
import { statSync } from "node:fs";
import { extname, isAbsolute, resolve } from "node:path/win32";
import type { Readable } from "node:stream";
import { awaitSandboxProof, ensureWinCageGrants, getSandboxMode, wrapSpawnForSandbox, type SandboxMode } from "../sandbox/index.js";
import { underUserProfile } from "../sandbox/win-cage.js";
import { winCageReadGrants } from "../sandbox/win-cage-grants.js";
import { killProcessGroup } from "../process-tree-kill.js";
import { buildSanitizedEnv, resolveWindowsShell } from "./shell-env.js";
import { shellProxyEnv, shellProxyEnvSync } from "./shell-proxy-env.js";

/** A command line, run through the platform shell exactly as the bash tool
 *  runs one, or a program and its argv, run with no shell in between (so a
 *  Windows `.cmd` shim such as npm needs the command-line form). */
export type CagedSpawnSpec = string | { file: string; args: string[] };

export interface CagedSpawnOptions {
  cwd: string;
  /** Laid over the scrubbed env and the egress-proxy route; it wins over both. */
  env?: Record<string, string>;
  /** POSIX: the child leads its own process group, so a group kill reaches
   *  the processes it starts. */
  detached?: boolean;
  /** Ends the proof wait at once; an abort before the spawn starts nothing. */
  signal?: AbortSignal;
  /** Runs only when the spawn has to wait for the Windows fence proof. */
  onWait?: () => void;
}

export type CagedChild = ChildProcessByStdio<null, Readable, Readable>;

/** Git Bash on Windows (PowerShell when there is none), /bin/bash elsewhere. */
function shellInvocation(command: string): { file: string; args: string[] } {
  if (process.platform !== "win32") return { file: "/bin/bash", args: ["-c", command] };
  const shell = resolveWindowsShell();
  return { file: shell.path, args: shell.kind === "bash" ? ["-c", command] : ["-NoProfile", "-Command", command] };
}

function isFile(path: string): boolean {
  return statSync(path, { throwIfNoEntry: false })?.isFile() ?? false;
}

/**
 * A bare program name searched the way Node's own spawn searches (the name as
 * given only when it has an extension, then .com, then .exe), in the PATH's
 * absolute entries only: a relative one resolves against the server's own cwd,
 * which is neither the caller's cwd nor a place a program should come from.
 */
function onPath(file: string, env: Record<string, string>): string {
  const extensions = extname(file) ? ["", ".com", ".exe"] : [".com", ".exe"];
  for (const dir of (env.PATH ?? env.Path ?? "").split(";")) {
    if (!isAbsolute(dir)) continue;
    for (const ext of extensions) {
      const candidate = resolve(dir, file + ext);
      if (isFile(candidate)) return candidate;
    }
  }
  throw new Error(`"${file}" was not found on the PATH, so nothing was started.`);
}

/**
 * The full path of an argv-form program for the Windows cage, which its helper
 * starts by path, never by PATH search. Refused when running it would widen
 * what the sandbox user can read: the wrap grants read on the program's install
 * root (one level above a `bin` folder) for as long as the server runs, so a
 * program elsewhere under the profile would open that tree, or the whole
 * profile, to every later command. A program outside the profile, or inside a
 * root the shell's own grants already cover, adds nothing.
 */
function winCageProgram(file: string, env: Record<string, string>, cwd: string): string {
  const resolved = isAbsolute(file) || /[\\/]/.test(file) ? resolve(cwd, file) : onPath(file, env);
  if (!isFile(resolved)) throw new Error(`"${file}" was not found, so nothing was started.`);
  const readable = winCageReadGrants(resolveWindowsShell().path);
  // underUserProfile is the plain containment test: the root itself or below it.
  const widens = winCageReadGrants(resolved).some((grant) => !readable.some((root) => underUserProfile(grant, root)));
  if (widens) throw new Error(`"${resolved}" is in your user profile, outside the folders the shell cage may read, so nothing was started.`);
  return resolved;
}

function program(spec: CagedSpawnSpec, env: Record<string, string>, cwd: string, winCage: boolean): { file: string; args: string[] } {
  if (typeof spec === "string") return shellInvocation(spec);
  return { file: winCage ? winCageProgram(spec.file, env, cwd) : spec.file, args: spec.args };
}

function launch(file: string, args: string[], env: Record<string, string>, opts: Pick<CagedSpawnOptions, "cwd" | "detached">): CagedChild {
  const wrapped = wrapSpawnForSandbox(file, args, env);
  return spawn(wrapped.cmd, wrapped.args, {
    env,
    cwd: opts.cwd,
    windowsHide: true,
    detached: opts.detached ?? false,
    stdio: ["ignore", "pipe", "pipe"],
  });
}

/** Step 3, awaited: the trusted shell's grants, on the Windows cage only. */
function awaitShellGrants(signal?: AbortSignal): Promise<void> {
  return process.platform === "win32" && getSandboxMode() === "guarded" ? ensureWinCageGrants(resolveWindowsShell().path, signal) : Promise.resolve();
}

/**
 * Start `spec` under the cage and return the child. Throws, having started
 * nothing, on an abort before the spawn (the signal's reason), on a Windows
 * proof still pending after the wait (SandboxProofPendingError), on Windows
 * grants that failed (WinCageGrantFailedError), and on an argv-form program
 * the Windows cage cannot find or would have to widen its reads for.
 */
export async function spawnCaged(spec: CagedSpawnSpec, opts: CagedSpawnOptions): Promise<CagedChild> {
  await awaitSandboxProof({ signal: opts.signal, onWait: opts.onWait });
  opts.signal?.throwIfAborted();
  const env = buildSanitizedEnv({ ...(await shellProxyEnv()), ...opts.env });
  const winCage = process.platform === "win32" && getSandboxMode() === "guarded";
  const { file, args } = program(spec, env, opts.cwd, winCage);
  await awaitShellGrants(opts.signal);
  opts.signal?.throwIfAborted();
  return launch(file, args, env, opts);
}

/**
 * Steps 1 and 3 for a caller that starts through spawnCagedSync but can wait
 * first (process_start, process_restart), so the start finds the cage ready
 * instead of being refused. An abort ends the wait; the caller reads its
 * signal. Throws WinCageGrantFailedError, having started nothing, once the
 * Windows grants have failed.
 */
export async function awaitCageReady(signal?: AbortSignal): Promise<void> {
  await awaitSandboxProof({ signal });
  if (!signal?.aborted) await awaitShellGrants(signal);
}

/**
 * spawnCaged for the start contract that cannot await (DevServerDeps.start,
 * served by startSession). The proxy route is read from the live proxy
 * (shellProxyEnvSync). It cannot wait for the Windows cage: while a fence
 * proof runs the wrap throws SandboxProofPendingError, and while the sandbox
 * user's grants are still being made WinCageGrantPendingError (it never makes
 * them on the event loop), having started nothing; callers that can wait
 * await awaitCageReady first.
 */
export function spawnCagedSync(spec: CagedSpawnSpec, opts: Pick<CagedSpawnOptions, "cwd" | "env" | "detached">): CagedChild {
  const env = buildSanitizedEnv({ ...shellProxyEnvSync(), ...opts.env });
  const winCage = process.platform === "win32" && getSandboxMode() === "guarded";
  const { file, args } = program(spec, env, opts.cwd, winCage);
  return launch(file, args, env, opts);
}

/** Bounds the capture, counted across both streams; output past it is dropped. */
const MAX_CAPTURE_CHARS = 10 * 1024 * 1024;

export interface CagedOutput {
  stdout: string;
  stderr: string;
}

export interface CagedRunOptions extends CagedSpawnOptions {
  /** From the spawn, so a proof wait never counts against the command. */
  timeoutMs: number;
  /** "close" (the default) settles once the child's output has ended, so all
   *  of it is captured. "exit" settles when the process exits: a shell's
   *  background job (`server &`) inherits the pipes and would otherwise hold
   *  the run open until the timeout. */
  settleOn?: "exit" | "close";
  /** After each chunk, with the capture so far. The same object every call,
   *  updated in place, so a deferred reader sees the latest output. */
  onOutput?: (captured: CagedOutput) => void;
}

export type CagedRunOutcome =
  | { kind: "exit"; code: number | null; signal: NodeJS.Signals | null; stdout: string; stderr: string; durationMs: number; sandboxMode: SandboxMode }
  | { kind: "timeout"; stdout: string; stderr: string; durationMs: number }
  | { kind: "abort"; durationMs: number };

/**
 * Run `spec` under the cage to completion. A timeout or an abort kills the
 * process tree and resolves with what was captured; a non-zero exit resolves
 * too. Rejects only when nothing could run: the spawn failed or was refused.
 * `sandboxMode` on an exit is the mode the command ran under, for reading a
 * denial in its output.
 */
export async function runCaged(spec: CagedSpawnSpec, opts: CagedRunOptions): Promise<CagedRunOutcome> {
  const waitStart = Date.now();
  let child: CagedChild;
  try {
    child = await spawnCaged(spec, opts);
  } catch (e) {
    if (opts.signal?.aborted) return { kind: "abort", durationMs: Date.now() - waitStart };
    throw e;
  }
  const sandboxMode = getSandboxMode();
  const startMs = Date.now();
  return new Promise<CagedRunOutcome>((resolveP, rejectP) => {
    const captured: CagedOutput = { stdout: "", stderr: "" };
    let capturedChars = 0;
    let settled = false;
    const killTree = (): void => { if (child.pid) killProcessGroup(child.pid, child); };
    const onAbort = (): void => {
      killTree();
      settle(() => resolveP({ kind: "abort", durationMs: Date.now() - startMs }));
    };
    const timer = setTimeout(() => {
      killTree();
      settle(() => resolveP({ kind: "timeout", durationMs: Date.now() - startMs, stdout: captured.stdout, stderr: captured.stderr }));
    }, opts.timeoutMs);
    function settle(finish: () => void): void {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      opts.signal?.removeEventListener("abort", onAbort);
      finish();
    }
    // Aborted while the env and grants were prepared: the child is already up.
    if (opts.signal?.aborted) { onAbort(); return; }
    opts.signal?.addEventListener("abort", onAbort, { once: true });

    const capture = (stream: keyof CagedOutput) => (chunk: string): void => {
      capturedChars += chunk.length;
      if (capturedChars <= MAX_CAPTURE_CHARS) captured[stream] += chunk;
      opts.onOutput?.(captured);
    };
    child.stdout.setEncoding("utf-8");
    child.stderr.setEncoding("utf-8");
    child.stdout.on("data", capture("stdout"));
    child.stderr.on("data", capture("stderr"));

    child.on("error", (e) => settle(() => rejectP(e)));
    const done = (code: number | null, signal: NodeJS.Signals | null): void => settle(() => resolveP({
      kind: "exit", code, signal, stdout: captured.stdout, stderr: captured.stderr, durationMs: Date.now() - startMs, sandboxMode,
    }));
    if (opts.settleOn === "exit") child.on("exit", done);
    else child.on("close", done);
  });
}
