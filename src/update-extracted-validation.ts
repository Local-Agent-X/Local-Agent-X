/** Validate and build a rolling source candidate before it can overwrite the live install. */

import { execSync, type ChildProcess } from "node:child_process";
import { existsSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";

import { runDesktopTscBuildAsync } from "./agency/worktree.js";
import { linkDirectoryInto, unlinkSharedJunctions } from "./agency/worktree-junctions.js";
import { createLogger } from "./logger.js";
import { gateBuildAtAsync, gateBindAt, gateSmoke, killProbe, SKIPPED_GATE, BUILD_TIMEOUT_MS, type GateResult } from "./self-edit/sandbox-gates.js";
import { pickProbePort } from "./self-edit/sandbox-naming.js";
import type { UpdateGates } from "./update-pipeline.js";

const logger = createLogger("update-pipeline");

export interface ExtractValidation {
  ok: boolean;
  detail: string;
  depsChanged: boolean;
  desktopDepsChanged: boolean;
  gates: UpdateGates;
}

/** Windows can retain just-killed probe handles briefly; cleanup retries must
 * never decide whether an otherwise valid update succeeds. */
export async function rmUpdatePathRetry(path: string, label: string): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    try { rmSync(path, { recursive: true, force: true }); return; }
    catch (e) {
      if (attempt >= 5) {
        logger.warn(`[update] could not remove ${label} at ${path}: ${(e as Error).message}`);
        return;
      }
      await new Promise(resolve => setTimeout(resolve, 600));
    }
  }
}

function fileDiffers(a: string, b: string): boolean {
  const ra = existsSync(a) ? readFileSync(a, "utf-8") : "";
  const rb = existsSync(b) ? readFileSync(b, "utf-8") : "";
  return ra !== rb;
}

/**
 * Gate an extracted update tree before OTAManager copies it over the install.
 * Both server and Electron sources are compiled inside the candidate. Shared
 * dependency links are always removed before the caller can copy or delete it.
 */
export async function validateExtractedUpdate(extractDir: string, installDir: string, authToken: string): Promise<ExtractValidation> {
  let probeProc: ChildProcess | null = null;
  let probeDataDir: string | null = null;
  const depsChanged =
    fileDiffers(join(extractDir, "package.json"), join(installDir, "package.json")) ||
    fileDiffers(join(extractDir, "package-lock.json"), join(installDir, "package-lock.json"));
  const desktopDepsChanged =
    fileDiffers(join(extractDir, "desktop", "package.json"), join(installDir, "desktop", "package.json")) ||
    fileDiffers(join(extractDir, "desktop", "package-lock.json"), join(installDir, "desktop", "package-lock.json"));

  try {
    let deps: GateResult;
    if (depsChanged) {
      const start = Date.now();
      try {
        execSync("npm ci", { cwd: extractDir, encoding: "utf-8", timeout: BUILD_TIMEOUT_MS, windowsHide: true, maxBuffer: 10 * 1024 * 1024 });
        deps = { ok: true, skipped: false, durationMs: Date.now() - start, detail: "isolated npm ci passed" };
      } catch (e) {
        const err = e as { stdout?: string; stderr?: string; message: string };
        const detail = (err.stderr || err.stdout || err.message).slice(-1500);
        return { ok: false, depsChanged, desktopDepsChanged, detail: `deps gate failed: ${detail.slice(0, 600)}`, gates: { deps: { ok: false, skipped: false, durationMs: Date.now() - start, detail }, build: SKIPPED_GATE, bind: SKIPPED_GATE, smoke: SKIPPED_GATE } };
      }
    } else {
      deps = { ok: true, skipped: true, durationMs: 0, detail: "no dependency changes" };
      linkDirectoryInto(join(installDir, "node_modules"), join(extractDir, "node_modules"));
      const pkgsDir = join(installDir, "packages");
      if (existsSync(pkgsDir)) {
        for (const pkg of readdirSync(pkgsDir)) {
          const srcNm = join(pkgsDir, pkg, "node_modules");
          if (statSync(join(pkgsDir, pkg)).isDirectory() && existsSync(srcNm)) {
            linkDirectoryInto(srcNm, join(extractDir, "packages", pkg, "node_modules"));
          }
        }
      }
    }

    if (desktopDepsChanged) {
      try {
        execSync("npm ci", { cwd: join(extractDir, "desktop"), encoding: "utf-8", timeout: BUILD_TIMEOUT_MS, windowsHide: true, maxBuffer: 10 * 1024 * 1024 });
      } catch (e) {
        const err = e as { stdout?: string; stderr?: string; message: string };
        const detail = (err.stderr || err.stdout || err.message).slice(-1500);
        return { ok: false, depsChanged, desktopDepsChanged, detail: `desktop deps gate failed: ${detail.slice(0, 600)}`, gates: { deps, build: SKIPPED_GATE, bind: SKIPPED_GATE, smoke: SKIPPED_GATE } };
      }
    } else {
      linkDirectoryInto(join(installDir, "desktop", "node_modules"), join(extractDir, "desktop", "node_modules"));
    }

    const serverBuild = await gateBuildAtAsync(extractDir);
    if (!serverBuild.ok) {
      return { ok: false, depsChanged, desktopDepsChanged, detail: `build gate failed: ${serverBuild.detail.slice(0, 600)}`, gates: { deps, build: serverBuild, bind: SKIPPED_GATE, smoke: SKIPPED_GATE } };
    }
    const desktopBuildStarted = Date.now();
    const desktopBuildOutcome = await runDesktopTscBuildAsync(extractDir, BUILD_TIMEOUT_MS);
    const build: GateResult = {
      ok: desktopBuildOutcome.ok,
      skipped: false,
      durationMs: serverBuild.durationMs + (Date.now() - desktopBuildStarted),
      detail: desktopBuildOutcome.ok ? "server + desktop builds passed" : desktopBuildOutcome.detail,
    };
    if (!build.ok) {
      return { ok: false, depsChanged, desktopDepsChanged, detail: `desktop build gate failed: ${build.detail.slice(0, 600)}`, gates: { deps, build, bind: SKIPPED_GATE, smoke: SKIPPED_GATE } };
    }

    const port = await pickProbePort();
    const bindOutcome = await gateBindAt(extractDir, port, authToken);
    probeProc = bindOutcome.proc;
    probeDataDir = bindOutcome.dataDir;
    if (!bindOutcome.result.ok) {
      return { ok: false, depsChanged, desktopDepsChanged, detail: `bind gate failed: ${bindOutcome.result.detail.slice(0, 600)}`, gates: { deps, build, bind: bindOutcome.result, smoke: SKIPPED_GATE } };
    }
    const smoke = await gateSmoke(port, authToken);
    if (!smoke.ok) {
      return { ok: false, depsChanged, desktopDepsChanged, detail: `smoke gate failed: ${smoke.detail.slice(0, 600)}`, gates: { deps, build, bind: bindOutcome.result, smoke } };
    }
    return { ok: true, depsChanged, desktopDepsChanged, detail: "all gates passed", gates: { deps, build, bind: bindOutcome.result, smoke } };
  } finally {
    await killProbe(probeProc);
    if (probeDataDir) await rmUpdatePathRetry(probeDataDir, "probe data dir");
    const stuck = unlinkSharedJunctions(extractDir);
    if (stuck.length === 0) {
      for (const [nm, label] of [
        [join(extractDir, "node_modules"), "extracted node_modules"],
        [join(extractDir, "desktop", "node_modules"), "extracted desktop node_modules"],
      ] as const) {
        if (existsSync(nm)) await rmUpdatePathRetry(nm, label);
      }
    } else {
      logger.error(`[update] junction(s) still live in extract dir — leaving node_modules untouched: ${stuck.join(", ")}`);
    }
  }
}
