// LAX server connection config + project-root resolution. Read once at
// boot from ~/.lax/config.json and cached. Restart Server menu calls
// reloadLAXConfig() so port/token changes pick up without an Electron
// restart.

import { app } from "electron";
import { existsSync, readFileSync, statSync } from "fs";
import { join, resolve } from "path";
import { homedir } from "os";

export const LAX_DIR = join(homedir(), ".lax");
export const CONFIG_PATH = join(LAX_DIR, "config.json");
export const DESKTOP_SETTINGS_PATH = join(LAX_DIR, "desktop-settings.json");

// R4-08 hardening: the projectRoot in ~/.lax/config.json decides the server
// child's spawn cwd and which src/index.ts we execute. A foreign-owned or
// world/group-writable config (or a projectRoot owned by someone else) means
// an attacker who already has local code-exec could redirect the next launch
// to attacker-controlled code. Before trusting either path, confirm the
// current user owns it and (for the config file) that it isn't group/world
// writable. POSIX-only: Windows statSync doesn't report meaningful uid/mode
// and process.getuid is undefined there, so we skip the check rather than
// risk refusing a legitimate Windows launch. On failure we DON'T crash: the
// resolver returns path:null + an explanatory error, which main.ts routes to
// the same self-heal/splash path as a missing config (it can prompt the user
// to pick a folder) — never spawning the server with an untrusted cwd.
function isUserOwnedSecure(path: string, requireNotGroupWorldWritable: boolean): boolean {
  if (process.platform === "win32") return true; // not enforceable on Windows
  const getuid = process.getuid;
  if (typeof getuid !== "function") return true; // non-POSIX runtime — can't check
  try {
    const st = statSync(path);
    if (st.uid !== getuid.call(process)) return false;
    // Mode bits 0o022 = group-write | other-write. A config file an
    // attacker can rewrite without owning is as good as owned.
    if (requireNotGroupWorldWritable && (st.mode & 0o022) !== 0) return false;
    return true;
  } catch {
    return false;
  }
}

// In packaged mode __dirname is inside app.asar — use config to find the
// live repo. Sentinel is src/index.ts (not dist/index.js) — we run the
// server from src via tsx, so dist may not exist on a fresh install.
//
// In dev mode (`npm run dev` / `npm run start` from desktop/) the .app is
// not packaged, and devRoot resolves to the repo because dist/main.js
// lives at <repo>/desktop/dist. In packaged mode devRoot resolves into
// app.asar, which is meaningless to reconcile / server-process — so we
// refuse to fall back there. PROJECT_ROOT becomes null and
// PROJECT_ROOT_ERROR carries the user-facing explanation. main.ts checks
// both before doing anything else and aborts to the splash if unset.
const _projectRoot: { path: string | null; error: string | null } = (() => {
  const devRoot = resolve(__dirname, "..", "..");
  if (!app.isPackaged) return { path: devRoot, error: null };

  // R4-08: refuse a config we can't trust to source the spawn cwd. A
  // foreign-owned or group/world-writable config.json could have been
  // rewritten by an attacker (who already has local code-exec as some
  // user) to point projectRoot at attacker code. We'd rather abort to the
  // splash (same UX as a missing config) than spawn with an untrusted cwd.
  // A legitimate user's own ~/.lax/config.json passes this check, so it
  // doesn't break normal launches.
  if (!isUserOwnedSecure(CONFIG_PATH, true)) {
    return {
      path: null,
      error: `~/.lax/config.json is not owned by you or is group/world-writable, so it can't be trusted to locate the app. Run: chown "$(whoami)" ~/.lax/config.json && chmod 600 ~/.lax/config.json`,
    };
  }

  let cfgProjectRoot: string | undefined;
  try {
    const cfg = JSON.parse(readFileSync(CONFIG_PATH, "utf-8"));
    cfgProjectRoot = cfg.projectRoot;
  } catch (e) {
    return {
      path: null,
      error: `~/.lax/config.json missing or unreadable (${(e as Error).message}). Re-run the LAX installer or set projectRoot manually.`,
    };
  }

  if (!cfgProjectRoot) {
    return {
      path: null,
      error: `~/.lax/config.json has no projectRoot field. Re-run the LAX installer or add {"projectRoot": "/path/to/Local-Agent-X"} to ~/.lax/config.json.`,
    };
  }
  if (!existsSync(join(cfgProjectRoot, "src", "index.ts"))) {
    return {
      path: null,
      error: `projectRoot "${cfgProjectRoot}" does not contain src/index.ts. Edit ~/.lax/config.json so projectRoot points at your Local-Agent-X repo.`,
    };
  }
  // R4-08: the resolved repo must be owned by the current user too — a repo
  // dir owned by someone else means its src/index.ts (what we spawn) is
  // attacker-controllable. Don't require non-group-writable here: a repo
  // checkout's group bits vary legitimately across dev setups; ownership is
  // the load-bearing check for "who can replace the code we run".
  const resolvedRoot = resolve(cfgProjectRoot);
  if (!isUserOwnedSecure(resolvedRoot, false)) {
    return {
      path: null,
      error: `projectRoot "${cfgProjectRoot}" is not owned by you, so the code it points at can't be trusted to run. Point projectRoot at a repo you own, or re-run the LAX installer.`,
    };
  }
  return { path: resolvedRoot, error: null };
})();

// PROJECT_ROOT may be mutated post-launch by project-root-resolver.ts when
// auto-discovery or the user picker resolves a path. CommonJS importers
// destructure once at import time, so the initial export captures the
// module-load value — consumers that need the live value (server-process,
// ipc, window) must use getProjectRoot() instead.
export const PROJECT_ROOT: string | null = _projectRoot.path;
export const PROJECT_ROOT_ERROR: string | null = _projectRoot.error;

let _liveProjectRoot: string | null = _projectRoot.path;
let _liveProjectRootError: string | null = _projectRoot.error;

export function getProjectRoot(): string | null {
  return _liveProjectRoot;
}
export function getProjectRootError(): string | null {
  return _liveProjectRootError;
}
export function setProjectRoot(path: string): void {
  _liveProjectRoot = path;
  _liveProjectRootError = null;
}

// PNG works for both BrowserWindow + Tray on Windows/Mac/Linux at runtime.
// Platform-specific .ico/.icns are used by electron-builder for the
// packaged installer art, not at runtime. When PROJECT_ROOT is null the
// app will abort before tray creation, but Electron may still try to read
// the icon for splash/error windows — point at the asar-bundled fallback
// (electron-builder ships public/icon.png as extraResource).
export const ICON_PATH = PROJECT_ROOT
  ? join(PROJECT_ROOT, "public", "icon.png")
  : join(process.resourcesPath || __dirname, "icon.png");

export interface LAXConfig {
  port: number;
  authToken: string;
}

const DEFAULTS: LAXConfig = { port: 7007, authToken: "" };

let cached: LAXConfig | null = null;

export function loadLAXConfig(): LAXConfig {
  try {
    if (existsSync(CONFIG_PATH)) {
      const raw = JSON.parse(readFileSync(CONFIG_PATH, "utf-8"));
      return {
        port: raw.port ?? DEFAULTS.port,
        authToken: raw.authToken ?? DEFAULTS.authToken,
      };
    }
  } catch {}
  return { ...DEFAULTS };
}

export function getLAXConfig(): LAXConfig {
  if (!cached) cached = loadLAXConfig();
  return cached;
}

export function reloadLAXConfig(): LAXConfig {
  cached = loadLAXConfig();
  return cached;
}
