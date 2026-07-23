/**
 * Executes the harness-owned framework scaffold — the RUN side of the pure plan
 * in framework-scaffold.ts. Lives in src/tools/ (never src/canonical-loop/) so
 * the adapter reaches it by a function-call/dynamic-import boundary and the
 * canonical-loop subprocess audit stays clean, the same arrangement
 * build-app-spawn.ts uses for the build CLI. The framework→command mapping is
 * NOT duplicated here — it comes from viteScaffoldPlan.
 */
import { spawn } from "node:child_process";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { killProcessTree } from "../process-tree-kill.js";
import { hardenChildEnv } from "./env-contamination.js";
import type { DetectedFramework } from "./framework-detect.js";
import {
  harnessOwnsScaffold,
  viteScaffoldPlan,
  SCAFFOLD_MANIFEST_REL,
} from "./framework-scaffold.js";

// A cold `npm create` + two `npm install`s pull a heavy tree; 5 min is loose
// enough for a slow network yet still terminates a genuine hang (a stuck
// prompt, an auth loop) rather than wedging the build op's factory forever.
const SCAFFOLD_STEP_TIMEOUT_MS = 300_000;

export interface ScaffoldResult {
  /** True when the harness produced (or already had) a baseline it now owns. */
  scaffolded: boolean;
  framework: DetectedFramework;
}

/**
 * Deterministically stand up the framework baseline the harness OWNS, so the
 * model can only add code under src/ instead of hand-writing (and clobbering)
 * the skeleton. For an owned framework (Vite): run the official creator, install
 * Tailwind v4, overwrite vite.config with the LAX-canonical one (base path +
 * HMR), and drop a scaffold manifest the write-guard locks the baseline against.
 *
 * Idempotent: a retry or update re-enters with the scaffold already on disk and
 * returns without re-running. A non-owned framework is a no-op — the advised
 * prompt recipe still steers the model to scaffold it.
 */
export async function runFrameworkScaffold(
  appDir: string,
  appName: string,
  framework: DetectedFramework,
  opts: { signal?: AbortSignal; onEvent?: (e: { type: string; [k: string]: unknown }) => void } = {},
): Promise<ScaffoldResult> {
  if (!harnessOwnsScaffold(framework)) return { scaffolded: false, framework };
  if (existsSync(resolve(appDir, "package.json"))) return { scaffolded: true, framework: "vite" };

  mkdirSync(appDir, { recursive: true });
  const plan = viteScaffoldPlan(appName);
  for (const command of plan.commands) {
    await runScaffoldCommand(command, appDir, opts);
  }
  for (const f of plan.files) {
    const p = resolve(appDir, f.path);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, f.content, "utf-8");
  }
  const manifestPath = resolve(appDir, SCAFFOLD_MANIFEST_REL);
  mkdirSync(dirname(manifestPath), { recursive: true });
  writeFileSync(manifestPath, JSON.stringify(plan.manifest, null, 2), "utf-8");
  return { scaffolded: true, framework: "vite" };
}

/**
 * Converge an EXISTING harness-owned vite.config to the current canonical
 * template — the template evolves (base path → HMR env → the /api/connectors
 * dev proxy) and already-scaffolded apps would otherwise keep the old behavior
 * forever. Only touches apps whose scaffold manifest proves the harness owns
 * vite.config.ts (the write-guard rejects model writes to it, so overwriting
 * can't clobber app-authored config). Called by the dev-server spawn paths so
 * the refresh lands exactly when the config is next read. Returns true when
 * the file was rewritten; never throws (a broken manifest just skips).
 */
export function refreshOwnedViteConfig(appDir: string, appName: string): boolean {
  try {
    const manifestPath = resolve(appDir, SCAFFOLD_MANIFEST_REL);
    if (!existsSync(manifestPath)) return false;
    const manifest = JSON.parse(readFileSync(manifestPath, "utf-8")) as Partial<ScaffoldManifestShape>;
    if (manifest.framework !== "vite" || !manifest.ownedPaths?.includes("vite.config.ts")) return false;
    const configPath = resolve(appDir, "vite.config.ts");
    if (!existsSync(configPath)) return false;
    const canonical = viteScaffoldPlan(appName).files.find((f) => f.path === "vite.config.ts")?.content;
    if (!canonical || readFileSync(configPath, "utf-8") === canonical) return false;
    writeFileSync(configPath, canonical, "utf-8");
    return true;
  } catch {
    return false;
  }
}

interface ScaffoldManifestShape {
  framework: string;
  ownedPaths: string[];
}

function runScaffoldCommand(
  command: string,
  cwd: string,
  opts: { signal?: AbortSignal; onEvent?: (e: { type: string; [k: string]: unknown }) => void },
): Promise<void> {
  return new Promise<void>((resolveP, rejectP) => {
    const proc = spawn(command, {
      cwd,
      shell: true,
      // hardenChildEnv: strip __CFBundleIdentifier + guard process.title so a
      // node-based scaffolder can't SIGSEGV under the macOS app-bundle context
      // (env scrub alone is insufficient — see env-contamination.ts).
      env: { ...hardenChildEnv(process.env), NO_COLOR: "1" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let errOut = "";
    proc.stdout?.on("data", (d: Buffer) => {
      const last = d.toString().split(/\r?\n/).filter((l) => l.trim()).pop();
      if (last) opts.onEvent?.({ type: "tool_progress", toolName: "build_app", message: `scaffold: ${last.slice(0, 120)}` });
    });
    proc.stderr?.on("data", (d: Buffer) => { errOut += d.toString(); });

    const abortListener = (): void => { killProcessTree(proc); };
    if (opts.signal) {
      if (opts.signal.aborted) abortListener();
      else opts.signal.addEventListener("abort", abortListener);
    }
    const timer = setTimeout(() => {
      killProcessTree(proc);
      rejectP(new Error(`scaffold step timed out after ${Math.round(SCAFFOLD_STEP_TIMEOUT_MS / 1000)}s: ${command}`));
    }, SCAFFOLD_STEP_TIMEOUT_MS);

    proc.on("error", (e) => {
      clearTimeout(timer);
      opts.signal?.removeEventListener("abort", abortListener);
      rejectP(new Error(`scaffold step failed to start (${command}): ${e.message}`));
    });
    proc.on("close", (code) => {
      clearTimeout(timer);
      opts.signal?.removeEventListener("abort", abortListener);
      if (code === 0) resolveP();
      else rejectP(new Error(`scaffold step exited ${code}: ${command}${errOut.trim() ? `\n${errOut.trim().slice(-800)}` : ""}`));
    });
  });
}
