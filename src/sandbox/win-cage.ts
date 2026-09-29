// The Windows guarded cage: a dedicated local user fenced by Windows Filtering
// Platform, driven through the `srt-win` helper (Anthropic's sandbox runtime,
// Apache-2.0; docs/proposals/shell-sandbox-reuse-plan.md). A restricted token
// or a job object cannot fence the network on Windows — firewall rules match
// a real principal, not a token — so the shell runs as that user, and a
// machine-wide WFP filter set keyed to its SID blocks every outbound connect
// except loopback to the proxy port range (shell-egress-proxy.ts binds there).
//
// Installing the user and the filters takes one UAC prompt (`install`); every
// run after that is unelevated: the helper's broker logs the child on as the
// sandbox user under a restricted token in a kill-on-close job, with the env
// overlay this module passes. Nothing here is default-on: `guarded` on Windows
// is usable only when the helper is present, installed, and the fence is
// PROVEN by two probes at first use — a direct loopback connect outside the
// permit range is blocked, and one inside it succeeds. Anything short of that
// is the truthful `host` fallback the rest of the app already knows.
//
// The helper binary is not shipped by LAX yet (unsigned upstream; the plan
// builds and signs it from source for the installer). Until then its path
// comes from LAX_WIN_CAGE_HELPER or <data>/bin/srt-win.exe.

import { execFileSync, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { join } from "node:path";
import { getLaxDir } from "../lax-data-dir.js";
import { shellProxyPortRange } from "../net/shell-egress-proxy.js";
import { workspaceRoot } from "../config.js";
import { createLogger } from "../logger.js";

const logger = createLogger("sandbox.win-cage");

export const WIN_CAGE_HELPER_ENV = "LAX_WIN_CAGE_HELPER";

export function resolveWinCageHelper(): string | null {
  const fromEnv = process.env[WIN_CAGE_HELPER_ENV];
  if (fromEnv && existsSync(fromEnv)) return fromEnv;
  const bundled = join(getLaxDir(), "bin", "srt-win.exe");
  return existsSync(bundled) ? bundled : null;
}

export interface WinCageStatus {
  helper: string | null;
  installed: boolean;
  userSid?: string;
  /** The permit range the filters were installed with, when readable. */
  portRange?: string;
  /** One sentence for the settings page: why it is or is not usable. */
  detail: string;
}

/** The helper's `status` JSON, the fields this module reads. */
interface HelperStatus {
  user?: { cred_present?: boolean; marker_user_sid?: string | null; user?: { exists?: boolean; name?: string } };
  wfp?: { state?: string; port_range?: string };
}

export function parseHelperStatus(json: string): { installed: boolean; userSid?: string; portRange?: string } {
  const s = JSON.parse(json) as HelperStatus;
  const sid = s.user?.marker_user_sid ?? undefined;
  const installed = s.user?.user?.exists === true && s.user?.cred_present === true && typeof sid === "string";
  return { installed, ...(sid ? { userSid: sid } : {}), ...(s.wfp?.port_range ? { portRange: s.wfp.port_range } : {}) };
}

function runHelper(helper: string, args: string[], opts: { input?: string; timeoutMs?: number; cwd?: string } = {}): { code: number; stdout: string; stderr: string } {
  try {
    const stdout = execFileSync(helper, args, {
      encoding: "utf-8", windowsHide: true, timeout: opts.timeoutMs ?? 20_000,
      stdio: [opts.input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
      ...(opts.input === undefined ? {} : { input: opts.input }), ...(opts.cwd ? { cwd: opts.cwd } : {}),
    });
    return { code: 0, stdout, stderr: "" };
  } catch (e) {
    const err = e as { status?: number | null; stdout?: string; stderr?: string; message?: string };
    return { code: err.status ?? -1, stdout: err.stdout ?? "", stderr: err.stderr ?? (err.message ?? "") };
  }
}

export function winCageStatus(): WinCageStatus {
  if (process.platform !== "win32") return { helper: null, installed: false, detail: "The Windows network cage only applies on Windows." };
  const helper = resolveWinCageHelper();
  if (!helper) return { helper: null, installed: false, detail: `The cage helper is not present (set ${WIN_CAGE_HELPER_ENV} or place srt-win.exe under the data dir's bin folder).` };
  const r = runHelper(helper, ["status"]);
  if (r.code !== 0) return { helper, installed: false, detail: `The cage helper could not report its status (exit ${r.code}).` };
  try {
    const parsed = parseHelperStatus(r.stdout);
    return {
      helper, ...parsed,
      detail: parsed.installed
        ? `Installed: the sandbox user and the network fence are provisioned${parsed.portRange ? ` (loopback permit ${parsed.portRange})` : ""}.`
        : "Not installed: bash runs unconfined on this machine until the cage is installed (one administrator prompt).",
    };
  } catch {
    return { helper, installed: false, detail: "The cage helper's status could not be read." };
  }
}

// ── The fail-closed proof ─────────────────────────────────────────────────

async function listenLoopback(port: number): Promise<Server> {
  const server = createServer((c) => c.end("LISTENER"));
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(port, "127.0.0.1", resolve); });
  return server;
}

async function firstFreeInRange(from: number, to: number): Promise<Server | null> {
  for (let port = from; port <= to; port++) {
    try { return await listenLoopback(port); } catch { /* taken; try the next */ }
  }
  return null;
}

const CONNECT_PROBE = (port: number) =>
  `$c = New-Object Net.Sockets.TcpClient; try { $c.Connect('127.0.0.1', ${port}); 'CONNECT-OK' } catch { 'CONNECT-BLOCKED' } finally { $c.Dispose() }`;

let enforces: { ok: boolean; reason: string } | null = null;

/** Why guarded is unusable on this Windows host, or null when the fence is proven. */
export function winCageUnusableReason(): string | null {
  return winCageEnforcesSync() ? null : enforces?.reason ?? "The Windows network cage is not proven on this host.";
}

/**
 * Whether the fence holds, proven at first use and memoized: a connect from
 * inside the cage to a loopback listener OUTSIDE the permit range must be
 * blocked (the helper's own behavioral probe), and one INSIDE the range must
 * succeed (a PowerShell one-liner run as the sandbox user, since the app's
 * own node binary lives under the real user's profile, which the sandbox
 * user cannot read). Both, or the cage is not a cage.
 */
export function winCageEnforcesSync(): boolean {
  if (enforces) return enforces.ok;
  enforces = probe();
  if (!enforces.ok) logger.warn(`[win-cage] guarded unavailable: ${enforces.reason}`);
  return enforces.ok;
}

function probe(): { ok: boolean; reason: string } {
  if (process.platform !== "win32") return { ok: false, reason: "not Windows" };
  const status = winCageStatus();
  if (!status.helper) return { ok: false, reason: status.detail };
  if (!status.installed) return { ok: false, reason: status.detail };
  const helper = status.helper;
  // The probes need listeners; run them synchronously via a child node so
  // the mode resolver (sync) can call this. The outside-range listener is
  // an ephemeral port; the inside-range one is the first free proxy port.
  const range = shellProxyPortRange();
  const script = `
    const net = require("node:net"); const { execFileSync } = require("node:child_process");
    const helper = ${JSON.stringify(helper)};
    function listen(port) { return new Promise((res, rej) => { const s = net.createServer((c) => c.end("L")); s.once("error", rej); s.listen(port, "127.0.0.1", () => res(s)); }); }
    (async () => {
      const outside = await listen(0);
      let inside = null;
      for (let p = ${range.from}; p <= ${range.to} && !inside; p++) { try { inside = await listen(p); } catch {} }
      const out = {};
      try {
        execFileSync(helper, ["wfp", "verify", "--target", "127.0.0.1:" + outside.address().port], { encoding: "utf8", timeout: 20000, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
        out.outside = "blocked";
      } catch (e) { out.outside = e.status === 3 ? "connected" : "error:" + (e.status ?? e.message); }
      if (inside) {
        try {
          const r = execFileSync(helper, ["exec", "--quiet", "--", "powershell.exe", "-NoProfile", "-NonInteractive", "-Command", ${JSON.stringify(CONNECT_PROBE(0)).replace("0)", "\" + inside.address().port + \")")}], { encoding: "utf8", timeout: 30000, windowsHide: true, cwd: "C:\\\\", stdio: ["ignore", "pipe", "pipe"] });
          out.inside = r.includes("CONNECT-OK") ? "reached" : "blocked";
        } catch (e) { out.inside = "error:" + (e.status ?? e.message); }
      } else out.inside = "no-free-port";
      outside.close(); if (inside) inside.close();
      process.stdout.write(JSON.stringify(out));
    })();
  `;
  let result: { outside?: string; inside?: string };
  try {
    result = JSON.parse(execFileSync(process.execPath, ["-e", script], { encoding: "utf-8", timeout: 70_000, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] }));
  } catch (e) {
    return { ok: false, reason: `the fence probe could not run: ${(e as Error).message.split("\n")[0]}` };
  }
  if (result.outside !== "blocked") return { ok: false, reason: `the fence is not active: a connect from the cage to a loopback port outside the permit range was ${result.outside}` };
  if (result.inside !== "reached") return { ok: false, reason: `the proxy route is not reachable from the cage: a connect inside the permit range was ${result.inside}` };
  return { ok: true, reason: "" };
}

/** Test-only / after install: forget the memoized proof. */
export function _resetWinCageProbe(): void {
  enforces = null;
}

// ── Spawning ─────────────────────────────────────────────────────────────

/** Env keys that describe the REAL user's profile; the child gets the sandbox
 *  user's own (its isolated USERPROFILE/TEMP are the point). */
const PROFILE_KEYS = new Set([
  "USERPROFILE", "HOMEDRIVE", "HOMEPATH", "HOME", "APPDATA", "LOCALAPPDATA", "TEMP", "TMP", "TMPDIR",
  "USERNAME", "USERDOMAIN", "USERDOMAIN_ROAMINGPROFILE", "LOGONSERVER", "SESSIONNAME",
]);

/** The `--env KEY=VALUE` overlay: the sanitized shell env minus the real user's profile. */
export function winCageEnvOverlay(env: Record<string, string>): string[] {
  const pairs: string[] = [];
  for (const [key, value] of Object.entries(env)) {
    if (!value || PROFILE_KEYS.has(key.toUpperCase()) || key.includes("=")) continue;
    pairs.push(`${key}=${value}`);
  }
  return pairs;
}

export function wrapForWinCage(shell: string, shellArgs: string[], env: Record<string, string>, helper: string | null = resolveWinCageHelper()): { cmd: string; args: string[] } {
  if (!helper) return { cmd: shell, args: shellArgs };
  const overlay = winCageEnvOverlay(env).flatMap((pair) => ["--env", pair]);
  return { cmd: helper, args: ["exec", "--quiet", ...overlay, "--", shell, ...shellArgs] };
}

let workspaceGranted = false;

/** Grant the sandbox user write access to the workspace once per process
 *  (refcounted by the helper under this pid; revoked at exit). */
export function ensureWinCageWorkspaceGrant(): void {
  if (workspaceGranted) return;
  const status = winCageStatus();
  if (!status.helper || !status.userSid) return;
  const root = workspaceRoot();
  const r = runHelper(status.helper, ["acl", "grant", "--holder-pid", String(process.pid), "--sandbox-user-sid", status.userSid], {
    input: JSON.stringify({ read: [], write: [root] }),
  });
  if (r.code !== 0) {
    logger.warn(`[win-cage] workspace grant failed (exit ${r.code}): ${r.stderr.trim().split("\n")[0]}`);
    return;
  }
  workspaceGranted = true;
  const helper = status.helper;
  process.once("exit", () => {
    try { execFileSync(helper, ["acl", "revoke", "--holder-pid", String(process.pid)], { windowsHide: true, timeout: 10_000, stdio: "ignore" }); } catch { /* the helper prunes dead holders on its next acl op */ }
  });
}

// ── Install / uninstall (one UAC prompt each) ────────────────────────────

const INSTALL_EXIT: Record<number, string> = {
  0: "installed",
  10: "the administrator prompt was cancelled",
  12: "the network filters could not be installed",
  13: "already installed with a different port range or user; remove it first",
  14: "the sandbox user could not be provisioned",
};

export function installExitDetail(code: number): string {
  return INSTALL_EXIT[code] ?? `the helper exited with code ${code}`;
}

function runElevated(args: string[]): Promise<{ ok: boolean; code: number; detail: string }> {
  const helper = resolveWinCageHelper();
  if (!helper) return Promise.resolve({ ok: false, code: -1, detail: "the cage helper is not present" });
  return new Promise((resolve) => {
    const child = spawn(helper, args, { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    let err = "";
    child.stderr?.on("data", (d) => { err += d.toString(); });
    child.once("error", (e) => resolve({ ok: false, code: -1, detail: e.message }));
    child.once("exit", (code) => {
      const c = code ?? -1;
      _resetWinCageProbe();
      resolve({ ok: c === 0, code: c, detail: c === 0 ? installExitDetail(0) : `${installExitDetail(c)}${err.trim() ? ` — ${err.trim().split("\n").slice(-1)[0]}` : ""}` });
    });
  });
}

/** Provision the sandbox user and the fence for LAX's proxy range. UAC prompt. */
export function installWinCage(): Promise<{ ok: boolean; code: number; detail: string }> {
  const { from, to } = shellProxyPortRange();
  return runElevated(["install", "--proxy-port-range", `${from}-${to}`]);
}

/** Remove the fence and the sandbox user. UAC prompt. */
export function uninstallWinCage(): Promise<{ ok: boolean; code: number; detail: string }> {
  return runElevated(["uninstall"]);
}
