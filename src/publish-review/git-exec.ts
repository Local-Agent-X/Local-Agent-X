/**
 * The one way the publish review runs git. Everything here happens BEFORE the
 * user has approved anything, so the invocation is hardened against a repo that
 * would execute code on a read: no fsmonitor daemon, no ext:: transport, no
 * external diff or textconv driver (callers pass --no-ext-diff/--no-textconv),
 * no hooks (the push dry run passes --no-verify), no credential prompt that
 * could hang the gate, no optional index lock that could collide with the
 * agent's own git, and a hard timeout.
 *
 * stdout is hashed in full and retained only up to `keepBytes`, so a huge diff
 * still fingerprints exactly while the review sees a bounded excerpt.
 */
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";

export interface GitResult {
  code: number | null;
  stdout: string;
  stderr: string;
  /** sha256 of the COMPLETE stdout, even past keepBytes. */
  sha256: string;
  /** stdout was longer than keepBytes and `stdout` is its head. */
  truncated: boolean;
  /** git could not be started (not installed / not on PATH). */
  missing?: boolean;
  timedOut?: boolean;
}

const HARDENING = ["-c", "core.fsmonitor=false", "-c", "protocol.ext.allow=never", "--no-pager"];

/** Local git commands; the push dry run talks to the remote and gets longer. */
export const GIT_LOCAL_TIMEOUT_MS = 15_000;
export const GIT_REMOTE_TIMEOUT_MS = 45_000;

const DEFAULT_KEEP_BYTES = 256 * 1024;

export function runGit(
  cwd: string,
  args: string[],
  opts: { timeoutMs?: number; keepBytes?: number; input?: string } = {},
): Promise<GitResult> {
  const keep = opts.keepBytes ?? DEFAULT_KEEP_BYTES;
  return new Promise((resolve) => {
    const hash = createHash("sha256");
    const out: Buffer[] = [];
    let kept = 0;
    let truncated = false;
    let stderr = "";
    let settled = false;
    let timedOut = false;
    const finish = (r: Omit<GitResult, "sha256" | "stdout" | "truncated" | "stderr">) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ ...r, stdout: Buffer.concat(out).toString("utf8"), stderr, sha256: hash.digest("hex"), truncated, ...(timedOut ? { timedOut } : {}) });
    };
    const child = spawn("git", [...HARDENING, ...args], {
      cwd,
      windowsHide: true,
      stdio: [opts.input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
      env: {
        ...process.env,
        GIT_TERMINAL_PROMPT: "0",
        GCM_INTERACTIVE: "never",
        GIT_OPTIONAL_LOCKS: "0",
        LC_ALL: "C",
      },
    });
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
      finish({ code: null });
    }, opts.timeoutMs ?? GIT_LOCAL_TIMEOUT_MS);
    timer.unref?.();
    child.stdout?.on("data", (chunk: Buffer) => {
      hash.update(chunk);
      if (kept >= keep) { truncated = true; return; }
      const room = keep - kept;
      if (chunk.length > room) { out.push(chunk.subarray(0, room)); truncated = true; kept = keep; return; }
      out.push(chunk);
      kept += chunk.length;
    });
    child.stderr?.on("data", (chunk: Buffer) => { if (stderr.length < 8_000) stderr += chunk.toString("utf8"); });
    child.on("error", (e: NodeJS.ErrnoException) => finish({ code: null, missing: e.code === "ENOENT" }));
    child.on("close", (code) => finish({ code }));
    if (opts.input !== undefined) child.stdin?.end(opts.input);
  });
}

/** First meaningful line of git's stderr, for a human-readable reason. */
export function gitErrorLine(r: GitResult): string {
  if (r.missing) return "git is not installed or not on PATH";
  if (r.timedOut) return "git did not answer in time";
  const line = r.stderr.split(/\r?\n/).map((l) => l.trim()).find(Boolean);
  return (line ?? `git exited with code ${r.code}`).replace(/^(fatal|error):\s*/i, "").slice(0, 200);
}
