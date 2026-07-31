import { ChildProcess, execSync, spawn } from "child_process";
import { cpSync, existsSync, readFileSync, readdirSync, rmSync, statSync } from "fs";
import { join, relative } from "path";
import { Script } from "vm";
import { buildAugmentedPath } from "./server-process";

// In-flight reconcile children. Quitting during a build must stop the whole
// npm/tsc process tree before it can leave a partially-written dist behind.
const liveSteps = new Set<ChildProcess>();

/** Synchronous because Electron does not await async will-quit listeners. */
export function killReconcileStepsSync(): void {
  for (const proc of liveSteps) {
    if (!proc.pid) continue;
    if (process.platform === "win32") {
      try { execSync(`taskkill /PID ${proc.pid} /T /F`, { windowsHide: true, stdio: "ignore" }); } catch {}
    } else {
      try { process.kill(-proc.pid, "SIGKILL"); } catch {}
    }
  }
  liveSteps.clear();
}

export function runStep(cmd: string, args: string[], cwd: string, timeoutMs?: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const proc = spawn(cmd, args, {
      cwd,
      shell: process.platform === "win32",
      detached: process.platform !== "win32",
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, PATH: buildAugmentedPath() },
    });
    liveSteps.add(proc);
    let stderrTail = "";
    let settled = false;

    let timer: ReturnType<typeof setTimeout> | undefined;
    const clearTimer = () => { if (timer) { clearTimeout(timer); timer = undefined; } };
    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      clearTimer();
      liveSteps.delete(proc);
      reject(error);
    };
    if (timeoutMs && timeoutMs > 0) {
      timer = setTimeout(() => {
        timer = undefined;
        if (proc.pid) {
          if (process.platform === "win32") {
            try { execSync(`taskkill /PID ${proc.pid} /T /F`, { windowsHide: true, stdio: "ignore" }); } catch {}
          } else {
            try { process.kill(-proc.pid, "SIGKILL"); } catch {}
          }
        }
        fail(new Error(`${cmd} ${args.join(" ")} (cwd=${cwd}) timed out after ${timeoutMs}ms — killed.`));
      }, timeoutMs);
    }

    proc.stdout?.on("data", (b: Buffer) => process.stdout.write(b));
    proc.stderr?.on("data", (b: Buffer) => {
      stderrTail += b.toString();
      if (stderrTail.length > 4000) stderrTail = stderrTail.slice(-4000);
      process.stderr.write(b);
    });
    proc.on("error", (error) => fail(error));
    proc.on("exit", (code) => {
      if (settled) return;
      settled = true;
      clearTimer();
      liveSteps.delete(proc);
      if (code === 0) resolve();
      else reject(new Error(`${cmd} ${args.join(" ")} (cwd=${cwd}) exited ${code}. Last stderr:\n${stderrTail.slice(-1500)}`));
    });
  });
}

/** Return the first emitted JavaScript file V8 cannot parse. */
export function firstUnparseableJs(distDir: string): { file: string; error: string } | null {
  const files: string[] = [];
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir)) {
      const full = join(dir, name);
      const stat = statSync(full);
      if (stat.isDirectory()) walk(full);
      else if (name.endsWith(".js")) files.push(full);
    }
  };
  if (existsSync(distDir)) walk(distDir);
  for (const file of files) {
    try { new Script(readFileSync(file, "utf-8"), { filename: file }); }
    catch (error) { return { file, error: (error as Error).message }; }
  }
  return null;
}

/** Build desktop/dist atomically enough to keep the last working UI available. */
export async function rebuildDesktopDist(projectRoot: string, onStatus?: (text: string) => void): Promise<void> {
  onStatus?.("Building app updates…");
  const distDir = join(projectRoot, "desktop", "dist");
  const backupDir = `${distDir}.prev`;
  const haveBackup = existsSync(distDir);
  if (haveBackup) {
    rmSync(backupDir, { recursive: true, force: true });
    cpSync(distDir, backupDir, { recursive: true });
  }
  try {
    await runStep("npm", ["run", "build"], join(projectRoot, "desktop"), 300_000);
    const bad = firstUnparseableJs(distDir);
    if (bad) throw new Error(`${relative(projectRoot, bad.file)} — ${bad.error}`);
  } catch (error) {
    if (haveBackup) {
      rmSync(distDir, { recursive: true, force: true });
      cpSync(backupDir, distDir, { recursive: true });
    }
    rmSync(backupDir, { recursive: true, force: true });
    throw new Error(
      `Desktop build failed: ${(error as Error).message}. ` +
      `Reverted dist/ to the previous build so the app isn't bricked — the splash and Repair stay usable. ` +
      `Fix the source (or update again) and relaunch.`,
    );
  }
  rmSync(backupDir, { recursive: true, force: true });
}
