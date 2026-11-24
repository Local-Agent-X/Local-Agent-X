/**
 * Run one iOS command-line tool (xcrun, idb, pymobiledevice3) with a timeout,
 * capturing stdout and stderr. A tool that is not installed comes back as
 * `missing` rather than a thrown spawn error, so the caller can say which tool
 * to install. The iOS twin of android/adb-run.ts.
 */
import { spawn } from "node:child_process";

export interface IosRunResult {
  stdout: Buffer;
  stderr: string;
  code: number | null;
  /** The program is not on this machine (spawn ENOENT). */
  missing?: true;
}

export function runIosTool(bin: string, args: string[], timeoutMs = 20_000): Promise<IosRunResult> {
  return new Promise((resolve, reject) => {
    let proc;
    try {
      proc = spawn(bin, args, { stdio: ["ignore", "pipe", "pipe"] });
    } catch (e) {
      reject(new Error(`spawn ${bin} failed: ${(e as Error).message}`));
      return;
    }
    const chunks: Buffer[] = [];
    let stderr = "";
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try { proc.kill("SIGKILL"); } catch { /* already gone */ }
      reject(new Error(`${bin} ${args.join(" ")} timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    proc.stdout.on("data", (c: Buffer) => chunks.push(c));
    proc.stderr.on("data", (c: Buffer) => { stderr += c.toString(); });
    proc.on("error", (e: NodeJS.ErrnoException) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (e.code === "ENOENT") resolve({ stdout: Buffer.alloc(0), stderr: "", code: null, missing: true });
      else reject(new Error(`${bin} failed to start: ${e.message}`));
    });
    proc.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ stdout: Buffer.concat(chunks), stderr, code });
    });
  });
}

/** What to install, by program, for the "not installed" message. */
const INSTALL_HINTS: Record<string, string> = {
  xcrun: "Xcode (from the App Store), then `xcode-select --install`",
  idb: "Facebook's idb: `brew install facebook/fb/idb-companion` and `pip3 install fb-idb`",
  pymobiledevice3: "`pip install pymobiledevice3`",
};

/** Run and return stdout as text; throw with the tool's own error, or with
 *  what to install when the tool is missing. */
export async function runIosText(bin: string, args: string[], timeoutMs?: number): Promise<string> {
  const r = await runIosTool(bin, args, timeoutMs);
  if (r.missing) throw new Error(`${bin} is not installed. Install ${INSTALL_HINTS[bin] ?? bin}.`);
  if (r.code !== 0) throw new Error(r.stderr.trim() || `${bin} ${args.join(" ")} exited with code ${r.code}`);
  return r.stdout.toString("utf8");
}
