/**
 * Framework-aware completion for the CLI-subprocess app-build terminal.
 *
 * A framework project (Next/Vite/Nuxt/…) has NO root index.html — its entry
 * is the framework's own source tree, served by a dev server that LAX
 * reverse-proxies at /apps/<id>/. So the terminal's flat-HTML completion
 * (index.html gate + /index.html URL) is wrong for it on both counts:
 * the gate fails a successful build, and the URL 404s. This module decides,
 * per build, which completion model applies:
 *
 *   - static/unknown → { handled: false } — the adapter keeps its existing
 *     index.html gate and appUrl untouched.
 *   - real framework → verify the scaffold (package.json + the detection's
 *     evidence file), register the canonical frontend dev server
 *     (registerDevServer, kind "frontend" — the /apps/<id>/ route lazily
 *     starts and proxies it), and hand back the proxy URL (trailing slash,
 *     no index.html) as the APP_READY target.
 *
 * Sandbox boundary: this file lives under canonical-loop/adapters/ and is
 * audited by test/canonical-loop-11-boundary-audit.test.ts — subprocess
 * primitives stay behind function-call boundaries (registerDevServer routes
 * through process-session.ts). Defaults resolve via dynamic import so unit
 * tests that inject deps never load the process machinery.
 */
import { resolve } from "node:path";
import { verifyWriteLanded } from "../../tools/verify.js";
import { detectFramework, type DetectedFramework, type FrameworkDetection } from "../../tools/framework-detect.js";
import type { DevServerKind, DevServerRecord, RegisterResult } from "../../tools/dev-server.js";
import { supportsStaticBuild, writeRunTargetManifest } from "../../tools/app-run-target.js";
import type { StaticBuildResult } from "../../tools/static-build-run.js";
import { DEFAULT_BASE_PORT } from "../../auto-build/scenario-scorer/port-alloc.js";

/** How a finished app is served at /apps/<id>/. `static-build` builds a static
 *  `dist/` and serves it with no dev server (client-only SPAs); `dev-server`
 *  keeps a live framework dev server LAX reverse-proxies (the historical path,
 *  and the only honest option for SSR frameworks). */
export type RunTarget = "dev-server" | "static-build";

export interface FinalizeFrameworkInput {
  appDir: string;
  appName: string;
  /** LAX server port (process.env.LAX_PORT ?? "7007") — the proxy URL's port. */
  laxPort: string;
  /** False when the CLI runner reported an error: the scaffold gate still
   *  applies, but a failed build must not start a dev server. */
  registerServer: boolean;
  /** How to serve the finished app. Default "dev-server" preserves the historical
   *  behavior; "static-build" builds dist/ and drops the dev server for a
   *  static-buildable framework (falls back to dev-server, with a note, if the
   *  build fails or the framework isn't static-buildable). */
  runTarget?: RunTarget;
}

/** Test seam mirroring dev-server.ts's DevServerDeps: inject fakes so unit
 *  tests never touch real dev-server records, ports, or processes. */
export interface FinalizeFrameworkDeps {
  registerDevServer?: (input: {
    appId: string; command: string; port: number; cwd?: string; kind?: DevServerKind;
  }) => RegisterResult;
  listDevServerRecords?: () => DevServerRecord[];
  portBound?: (port: number) => boolean;
  /** Run the framework's production build → static dist/ (static-build target). */
  runStaticBuild?: (appDir: string, framework: DetectedFramework) => Promise<StaticBuildResult>;
  /** Forget the app's dev-server record after a static build so the static serve
   *  isn't shadowed by a stray dev server the model started during the build. */
  stopDevServer?: (appId: string, opts: { forget?: boolean }) => void;
}

export type FinalizeFrameworkResult =
  | { handled: false }
  | { handled: true; ok: true; url: string; framework: DetectedFramework; mode: RunTarget; note?: string }
  | { handled: true; ok: false; code: "artifact_missing" | "dev_server_failed"; message: string };

// Evidence like "next.config.mjs" names a file to verify; dep-based evidence
// (`package.json dependency "next"`) is already covered by the package.json gate.
const BARE_FILENAME_RE = /^[\w.-]+$/;

// Bound the port probe so a pathological all-ports-busy box can't stall the
// build terminal on repeated pidsOnPort execs; past the cap the last candidate
// is returned and a genuine collision surfaces via the dev server's own
// startup verification.
const MAX_PORT_PROBES = 20;

export async function finalizeFrameworkBuild(
  input: FinalizeFrameworkInput,
  deps: FinalizeFrameworkDeps = {},
): Promise<FinalizeFrameworkResult> {
  const { appDir, appName, laxPort, registerServer } = input;
  const detection = detectFramework(appDir);
  if (detection.framework === "static" || detection.framework === "unknown") {
    return { handled: false };
  }

  const pkg = verifyWriteLanded(resolve(appDir, "package.json"));
  if (!pkg.ok) {
    return incomplete(detection.framework, pkg.reason);
  }
  if (BARE_FILENAME_RE.test(detection.evidence)) {
    const evidence = verifyWriteLanded(resolve(appDir, detection.evidence));
    if (!evidence.ok) return incomplete(detection.framework, evidence.reason);
  }

  const url = `http://127.0.0.1:${laxPort}/apps/${appName}/`;
  if (!registerServer) return { handled: true, ok: true, url, framework: detection.framework, mode: "dev-server" };

  const d = await resolveDeps(deps);

  // Static-build target: build a static dist/ and serve THAT, with no dev server
  // — the finished-SPA path (no lingering process, browser/offline friendly).
  // Only for a static-buildable framework; a build failure degrades to the dev
  // server below, carrying a visible note (never a silent half-built ship).
  let staticNote: string | undefined;
  if ((input.runTarget ?? "dev-server") === "static-build" && supportsStaticBuild(detection.framework)) {
    const built = await d.runStaticBuild(appDir, detection.framework);
    if (built.ok && built.distDir) {
      writeRunTargetManifest(appDir, { mode: "static-build", distDir: built.distDir, framework: detection.framework });
      // A dev server the model spun up with app_serve_frontend during the build
      // would otherwise shadow the static serve (the /apps route prefers a live
      // frontend record) and keep a process alive for an app that no longer needs
      // one. Forget it so the route falls through to the built dist/.
      d.stopDevServer(appName, { forget: true });
      return { handled: true, ok: true, url, framework: detection.framework, mode: "static-build" };
    }
    staticNote = `static build failed, serving via dev server instead: ${built.error ?? "unknown error"}`;
  }

  const registered = registerDetectedFramework(detection, appDir, appName, Number(laxPort), d);
  if (registered.handled && registered.ok && staticNote) return { ...registered, note: staticNote };
  return registered;
}

/** Deps for registering a framework dev server — the sync subset of the finalize
 *  deps (no static-build / stop-server machinery). */
export type FrameworkServeDeps = Pick<ResolvedFinalizeDeps, "registerDevServer" | "listDevServerRecords" | "portBound">;

/** Register + start a detected framework's dev server. The port/command/register
 *  core, shared by the build finalizer and the open-time self-heal so the two can
 *  never derive a different command or port for the same app. Assumes the caller
 *  already confirmed a servable framework (detection ≠ static/unknown). */
function registerDetectedFramework(
  detection: FrameworkDetection, appDir: string, appName: string, laxPort: number, d: FrameworkServeDeps,
): FinalizeFrameworkResult {
  const port = pickDevPort(appName, laxPort, d);
  const command = detection.devCommand(port);
  if (!command) {
    return { handled: true, ok: false, code: "dev_server_failed", message: `no dev command for detected framework "${detection.framework}"` };
  }
  const registered = d.registerDevServer({ appId: appName, command, port, cwd: appDir, kind: "frontend" });
  if (!registered.ok) {
    return { handled: true, ok: false, code: "dev_server_failed", message: registered.error };
  }
  return { handled: true, ok: true, url: `http://127.0.0.1:${laxPort}/apps/${appName}/`, framework: detection.framework, mode: "dev-server" };
}

/**
 * Detect the framework at appDir and register+start its dev server, synchronously.
 * The build finalizer registers at build time; this is the SAME registration
 * driven on-open by workspace-app-serving when an app has no dev-server record —
 * a build that never registered one (e.g. a P-1-terminated build), or a cleared
 * record. It makes opening a framework app always boot its preview instead of
 * static-serving an un-transpiled Vite shell (blank page). Returns {handled:false}
 * when appDir is not a servable framework project (caller serves it as files).
 */
export function registerFrameworkDevServerFromDisk(
  appDir: string, appName: string, laxPort: number, d: FrameworkServeDeps,
): FinalizeFrameworkResult {
  const detection = detectFramework(appDir);
  if (detection.framework === "static" || detection.framework === "unknown") return { handled: false };
  const pkg = verifyWriteLanded(resolve(appDir, "package.json"));
  if (!pkg.ok) return incomplete(detection.framework, pkg.reason);
  if (BARE_FILENAME_RE.test(detection.evidence)) {
    const evidence = verifyWriteLanded(resolve(appDir, detection.evidence));
    if (!evidence.ok) return incomplete(detection.framework, evidence.reason);
  }
  return registerDetectedFramework(detection, appDir, appName, laxPort, d);
}

function incomplete(framework: DetectedFramework, reason: string): FinalizeFrameworkResult {
  return { handled: true, ok: false, code: "artifact_missing", message: `framework build (${framework}) incomplete: ${reason}` };
}

type ResolvedFinalizeDeps = Required<FinalizeFrameworkDeps>;

async function resolveDeps(d: FinalizeFrameworkDeps): Promise<ResolvedFinalizeDeps> {
  if (d.registerDevServer && d.listDevServerRecords && d.portBound && d.runStaticBuild && d.stopDevServer) {
    return d as ResolvedFinalizeDeps;
  }
  const devServer = await import("../../tools/dev-server.js");
  const { pidsOnPort } = await import("../../tools/process-session.js");
  const { runStaticBuild } = await import("../../tools/static-build-run.js");
  return {
    registerDevServer: d.registerDevServer ?? devServer.registerDevServer,
    listDevServerRecords: d.listDevServerRecords ?? devServer.listDevServerRecords,
    portBound: d.portBound ?? ((port) => pidsOnPort(port).length > 0),
    runStaticBuild: d.runStaticBuild ?? ((appDir, framework) => runStaticBuild(appDir, framework)),
    stopDevServer: d.stopDevServer ?? ((appId, opts) => devServer.stopDevServer(appId, {}, opts)),
  };
}

/** A rebuild reuses its own record's port (registerDevServer restarts the
 *  record); otherwise walk up from the base, skipping ports other records
 *  hold, the LAX port, and anything already bound on the box. */
function pickDevPort(appName: string, laxPort: number, d: FrameworkServeDeps): number {
  const records = d.listDevServerRecords();
  const own = records.find((r) => r.appId === appName);
  if (own) return own.port;
  const taken = new Set(records.map((r) => r.port));
  let port = DEFAULT_BASE_PORT;
  for (let probes = 0; probes < MAX_PORT_PROBES; probes++) {
    if (!taken.has(port) && port !== laxPort && !d.portBound(port)) return port;
    port += 1;
  }
  return port;
}
