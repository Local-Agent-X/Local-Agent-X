/**
 * The app_serve_* tools — the agent-facing wrappers over the dev-server
 * lifecycle (registerDevServer / stopDevServer in dev-server.ts). Split out to
 * keep dev-server.ts under the source-hygiene LOC cap; the readiness check
 * (waitForBackend) lives here too since only these tools use it.
 *
 * Both tools register a dev server, then DON'T claim success until the process
 * actually binds its port (or crashes) — so a dead/never-bound server is reported
 * as a failure with an actionable fix, never shipped as "ready".
 */
import type { ToolDefinition, ToolResult } from "../types.js";
import { workspacePath } from "../config.js";
import { registerDevServer, stopDevServer } from "./dev-server.js";
import { waitForBackend } from "./dev-server-readiness.js";
import { detectFramework, type DetectedFramework } from "./framework-detect.js";

/** How long to wait for a freshly-started backend to bind its port (or crash). */
const BACKEND_READY_TIMEOUT_MS = 20_000;
// A frontend dev server's cold `npm install` pulls a much heavier tree (vite +
// react + plugins), so give it longer to bind before calling it failed — a
// too-short window falsely reports "didn't start" and pushes the model toward a
// needless production build to "verify".
const FRONTEND_READY_TIMEOUT_MS = 60_000;

export const appServeBackendTool: ToolDefinition = {
  name: "app_serve_backend",
  description:
    "Start and keep alive a full-stack app's REAL backend dev server, and wire a connector so the app's frontend can reach it (same-origin — works from the phone too). Use this for full-stack apps INSTEAD of process_start + connector_create: it registers the backend so LAX lazily restarts it when the app is opened and stops it when the app is deleted. The frontend then fetches /api/connectors/dev-<app_id>/<path> with Authorization: 'Bearer ' + window.__LAX_CONNECTOR_TOKEN__.",
  parameters: {
    type: "object",
    properties: {
      app_id: { type: "string", description: "The app's directory name (workspace/apps/<app_id>)." },
      command: { type: "string", description: "Command that starts the backend, e.g. 'npm install && npm run dev' or 'node server.js'." },
      port: { type: "number", description: "The localhost port the backend listens on." },
      cwd: { type: "string", description: "Working directory for the command. Defaults to workspace/apps/<app_id>/server." },
    },
    required: ["app_id", "command", "port"],
  },
  async execute(args): Promise<ToolResult> {
    const appId = String(args.app_id || "").replace(/[^a-zA-Z0-9_-]/g, "-");
    const command = String(args.command || "");
    const port = Number(args.port);
    const cwd = args.cwd ? String(args.cwd) : undefined;
    const res = registerDevServer({ appId, command, port, cwd });
    if (!res.ok) return { content: `Could not start backend: ${res.error}`, isError: true };

    // Don't claim success until the backend actually binds its port (or fails).
    // This is what catches the real failures: a native module (e.g.
    // better-sqlite3) that won't `npm install` against this Node, a wrong cwd, a
    // missing script, an ESM error — all of which otherwise ship a dead backend.
    const outcome = await waitForBackend(res.sessionId, port, BACKEND_READY_TIMEOUT_MS);
    if (outcome.status === "crashed") {
      stopDevServer(appId, {}, { forget: true });   // definitively dead — don't auto-retry it
      return {
        content:
          `Backend for "${appId}" exited (code ${outcome.code}) — the command failed, so the app has no working backend.\n` +
          `Command: ${command} (runs from the app root ${res.cwd}).\n` +
          `Common cause: a native dependency pinned to an OLD version that can't compile against this Node — use Node's built-in node:sqlite (no install), or depend on "better-sqlite3": "latest" (recent versions ship a prebuilt binary; an old "^9.x" pin does not). Fix it and call app_serve_backend again.\n` +
          (outcome.output ? `Output:\n${outcome.output}` : "(no output captured)"),
        isError: true,
      };
    }
    if (outcome.status === "timeout") {
      return {
        content:
          `Backend for "${appId}" did NOT start listening on port ${port} within ${BACKEND_READY_TIMEOUT_MS / 1000}s — do not treat it as ready.\n` +
          `Likely a slow or failing install (an OLD native module like better-sqlite3 compiling from source), or it binds a different port. Check process_status(session_id="${res.sessionId}"); prefer node:sqlite (no build), or "better-sqlite3": "latest" (prebuilt).\n` +
          (outcome.output ? `Output:\n${outcome.output}` : ""),
        isError: true,
      };
    }
    return {
      content:
        `Backend for "${appId}" is up and listening on port ${port} (session ${res.sessionId}).\n` +
        `Connector "${res.connector}" wired — the frontend should fetch /api/connectors/${res.connector}/<path> ` +
        `with header Authorization: 'Bearer ' + window.__LAX_CONNECTOR_TOKEN__.\n` +
        `LAX will restart this backend when the app is opened and stop it when the app is deleted.`,
    };
  },
};

export type ResolvedServeCommand =
  | { ok: true; command: string; detected: DetectedFramework | null; evidence: string | null }
  | { ok: false; error: string };

/**
 * Decide what command app_serve_frontend runs: an explicit `command` always
 * wins; when omitted, sniff the app directory (framework-detect.ts) and use
 * the detected framework's dev command. Pure — unit-testable without spawning.
 */
export function resolveServeCommand(
  appDir: string,
  command: string | undefined,
  port: number,
): ResolvedServeCommand {
  const explicit = (command ?? "").trim();
  if (explicit) return { ok: true, command: explicit, detected: null, evidence: null };

  const det = detectFramework(appDir);
  if (det.framework === "static") {
    return {
      ok: false,
      error:
        `No command given, and auto-detect found a STATIC app (${det.evidence}) — a static app needs ` +
        `no dev server; LAX already serves it directly at its /apps/<app_id>/ URL. Do not call ` +
        `app_serve_frontend for it.`,
    };
  }
  const cmd = det.devCommand(port);
  if (!cmd) {
    return {
      ok: false,
      error:
        `No command given, and auto-detect could not identify the frontend framework in ${appDir} ` +
        `(${det.evidence}) — pass \`command\` explicitly, e.g. 'npm install && npm run dev'.`,
    };
  }
  return { ok: true, command: cmd, detected: det.framework, evidence: det.evidence };
}

export const appServeFrontendTool: ToolDefinition = {
  name: "app_serve_frontend",
  description:
    "Start and keep alive a build-step FRONTEND dev server (Vite / Next / a React/Vue/Svelte SPA with HMR) for an app. LAX reverse-proxies /apps/<app_id>/ straight to it, so the app's own URL serves the live dev server. Use this INSTEAD of writing a single static index.html when the frontend genuinely needs its own dev server / build step. REQUIRED dev-server config: set base path to '/apps/<app_id>/' and HMR client port to the dev port (so hot-reload connects from the browser on desktop), and bind the given port. Hot-reload is desktop-only for now; the phone shows the result on reload.",
  parameters: {
    type: "object",
    properties: {
      app_id: { type: "string", description: "The app's directory name (workspace/apps/<app_id>)." },
      command: { type: "string", description: "Command that starts the dev server, e.g. 'npm install && npm run dev'. Optional — when omitted, LAX auto-detects the framework (Next/Nuxt/SvelteKit/Astro/Remix/Vite) from the project and runs its dev command on the given port." },
      port: { type: "number", description: "The localhost port the dev server listens on (also the HMR client port)." },
      cwd: { type: "string", description: "Working directory. Defaults to workspace/apps/<app_id>." },
    },
    required: ["app_id", "port"],
  },
  async execute(args): Promise<ToolResult> {
    const appId = String(args.app_id || "").replace(/[^a-zA-Z0-9_-]/g, "-");
    const port = Number(args.port);
    const cwd = args.cwd ? String(args.cwd) : undefined;
    const appDir = cwd ?? workspacePath("apps", appId);
    // Coerce non-string command (null/number/omitted) to "not given" so it
    // auto-detects — NOT String(null)="null", which would run the shell
    // literal `null`. Only a real string is an explicit command.
    const resolved = resolveServeCommand(appDir, typeof args.command === "string" ? args.command : undefined, port);
    if (!resolved.ok) return { content: resolved.error, isError: true };
    const command = resolved.command;
    const res = registerDevServer({ appId, command, port, cwd, kind: "frontend" });
    if (!res.ok) return { content: `Could not start frontend dev server: ${res.error}`, isError: true };

    const outcome = await waitForBackend(res.sessionId, port, FRONTEND_READY_TIMEOUT_MS);
    if (outcome.status === "crashed") {
      stopDevServer(appId, {}, { forget: true });
      return {
        content:
          `Frontend dev server for "${appId}" exited (code ${outcome.code}) — the command failed, so /apps/${appId}/ has nothing to proxy.\n` +
          `Command: ${command} (runs from ${res.cwd}). Fix it and call app_serve_frontend again.\n` +
          (outcome.output ? `Output:\n${outcome.output}` : "(no output captured)"),
        isError: true,
      };
    }
    if (outcome.status === "timeout") {
      return {
        content:
          `Frontend dev server for "${appId}" did NOT start listening on port ${port} within ${FRONTEND_READY_TIMEOUT_MS / 1000}s — do not treat it as ready.\n` +
          `Likely a slow/failing install or a different port. Check process_status(session_id="${res.sessionId}").\n` +
          (outcome.output ? `Output:\n${outcome.output}` : ""),
        isError: true,
      };
    }
    const detectedNote = resolved.detected
      ? `Auto-detected ${resolved.detected} (${resolved.evidence}) — ran: ${command}\n`
      : "";
    return {
      content:
        `Frontend dev server for "${appId}" is up on port ${port} (session ${res.sessionId}). ` +
        `/apps/${appId}/ now reverse-proxies to it — open the app to see the live dev server.\n` +
        detectedNote +
        `Confirm the dev server's base is '/apps/${appId}/' and its HMR client port is ${port}, or assets/hot-reload will 404.\n` +
        `LAX restarts it when the app is opened and stops it when the app is deleted.`,
    };
  },
};
