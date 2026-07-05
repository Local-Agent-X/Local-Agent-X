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
import { detectFramework, type DetectedFramework } from "../../tools/framework-detect.js";
import type { DevServerKind, DevServerRecord, RegisterResult } from "../../tools/dev-server.js";
import { DEFAULT_BASE_PORT } from "../../auto-build/scenario-scorer/port-alloc.js";

export interface FinalizeFrameworkInput {
  appDir: string;
  appName: string;
  /** LAX server port (process.env.LAX_PORT ?? "7007") — the proxy URL's port. */
  laxPort: string;
  /** False when the CLI runner reported an error: the scaffold gate still
   *  applies, but a failed build must not start a dev server. */
  registerServer: boolean;
}

/** Test seam mirroring dev-server.ts's DevServerDeps: inject fakes so unit
 *  tests never touch real dev-server records, ports, or processes. */
export interface FinalizeFrameworkDeps {
  registerDevServer?: (input: {
    appId: string; command: string; port: number; cwd?: string; kind?: DevServerKind;
  }) => RegisterResult;
  listDevServerRecords?: () => DevServerRecord[];
  portBound?: (port: number) => boolean;
}

export type FinalizeFrameworkResult =
  | { handled: false }
  | { handled: true; ok: true; url: string; framework: DetectedFramework }
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
  if (!registerServer) return { handled: true, ok: true, url, framework: detection.framework };

  const d = await resolveDeps(deps);
  const port = pickDevPort(appName, Number(laxPort), d);
  const command = detection.devCommand(port);
  if (!command) {
    return { handled: true, ok: false, code: "dev_server_failed", message: `no dev command for detected framework "${detection.framework}"` };
  }
  const registered = d.registerDevServer({ appId: appName, command, port, cwd: appDir, kind: "frontend" });
  if (!registered.ok) {
    return { handled: true, ok: false, code: "dev_server_failed", message: registered.error };
  }
  return { handled: true, ok: true, url, framework: detection.framework };
}

function incomplete(framework: DetectedFramework, reason: string): FinalizeFrameworkResult {
  return { handled: true, ok: false, code: "artifact_missing", message: `framework build (${framework}) incomplete: ${reason}` };
}

type ResolvedFinalizeDeps = Required<FinalizeFrameworkDeps>;

async function resolveDeps(d: FinalizeFrameworkDeps): Promise<ResolvedFinalizeDeps> {
  if (d.registerDevServer && d.listDevServerRecords && d.portBound) return d as ResolvedFinalizeDeps;
  const devServer = await import("../../tools/dev-server.js");
  const { pidsOnPort } = await import("../../tools/process-session.js");
  return {
    registerDevServer: d.registerDevServer ?? devServer.registerDevServer,
    listDevServerRecords: d.listDevServerRecords ?? devServer.listDevServerRecords,
    portBound: d.portBound ?? ((port) => pidsOnPort(port).length > 0),
  };
}

/** A rebuild reuses its own record's port (registerDevServer restarts the
 *  record); otherwise walk up from the base, skipping ports other records
 *  hold, the LAX port, and anything already bound on the box. */
function pickDevPort(appName: string, laxPort: number, d: ResolvedFinalizeDeps): number {
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
