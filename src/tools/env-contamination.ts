// Host-process contamination scrub for spawned subprocesses.
//
// Vars the Electron desktop / launchd injects into the SERVER's own environment
// that must NEVER propagate to a spawned child. They're not credentials, so the
// credential scrub in shell-env.ts would pass them through — but a user
// dev/build command inheriting them misbehaves or hard-crashes:
//   - __CFBundleIdentifier: makes CoreFoundation resolve the child's "main
//     bundle" to the LAX .app. When a child node sets process.title (vite v8,
//     next, webpack, jest all do), libuv's uv_set_process_title →
//     CFBundleGetInfoDictionary(CFBundleGetMainBundle()) dereferences that
//     inherited-but-wrong bundle and SIGSEGVs at boot (PAC signature failure) —
//     BEFORE the process prints anything (the "code null, no output" dev-server
//     death). Fatal on macOS; the desktop app is exactly this responsibility
//     context, a plain terminal is not (why isolated repros survived).
//   - NODE_CHANNEL_FD / NODE_CHANNEL_SERIALIZATION_MODE: the Electron→server
//     IPC fork() channel. A grandchild node inheriting these attaches fd 3 as an
//     IPC channel it doesn't own.
//   - ELECTRON_RUN_AS_NODE / __CF_USER_TEXT_ENCODING: host-runtime specifics
//     that have no business in a user subprocess.
import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const HOST_CONTAMINATION_ENV_KEYS = new Set([
  "__CFBundleIdentifier", "__CF_USER_TEXT_ENCODING",
  "NODE_CHANNEL_FD", "NODE_CHANNEL_SERIALIZATION_MODE",
  "ELECTRON_RUN_AS_NODE",
]);
const HOST_CONTAMINATION_ENV_PREFIXES = ["ELECTRON_", "__CF"];

/** True if `key` is host-process (Electron / CoreFoundation / IPC) contamination
 *  that must not reach a spawned child. */
export function isHostContaminationEnvKey(key: string): boolean {
  return HOST_CONTAMINATION_ENV_KEYS.has(key) || HOST_CONTAMINATION_ENV_PREFIXES.some((p) => key.startsWith(p));
}

/**
 * Strip host-contamination vars from an env object, returning a fresh copy. For
 * the build/scaffold spawn paths that deliberately pass `{ ...process.env }`
 * through (they need the user's toolchain env, so they DON'T use the credential-
 * scrubbing buildSanitizedEnv) but must still not hand a child the __CFBundleIdentifier
 * that SIGSEGVs a `vite build` / scaffolder when it sets process.title on macOS.
 */
export function stripHostContaminationEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(env)) {
    if (!isHostContaminationEnvKey(k)) out[k] = v;
  }
  return out;
}

// ── process.title crash guard (macOS) ──────────────────────────────────────
//
// A node child spawned under the Electron app-bundle *responsibility* context
// SIGSEGVs in uv_set_process_title → CFBundleGetInfoDictionary the instant it
// sets process.title (vite v8, next, webpack, jest all do), before it prints
// anything. Stripping __CFBundleIdentifier (above) is NOT sufficient — the
// responsibility is a posix_spawn attribute Node can't clear. So instead we stop
// the child from ever CALLING uv_set_process_title: a tiny --require preload
// redefines process.title as a no-op. Injected via NODE_OPTIONS, which
// propagates through npm/npx to the leaf node. Verified live: vite goes from
// SIGSEGV-at-64ms to listening. macOS-only; a no-op elsewhere.
const NO_TITLE_PRELOAD =
  "try{Object.defineProperty(process,'title',{configurable:true,enumerable:true,get(){return 'node'},set(){}})}catch(e){}\n";

let _preloadPath: string | null | undefined;
function noTitlePreloadPath(): string | null {
  if (_preloadPath !== undefined) return _preloadPath;
  try {
    // tmpdir is readable in every sandbox mode (host + guarded seatbelt) and has
    // no spaces on macOS (NODE_OPTIONS is space-split, so a spaced path breaks).
    const p = join(tmpdir(), "lax-node-no-process-title.cjs");
    writeFileSync(p, NO_TITLE_PRELOAD);
    _preloadPath = p;
  } catch { _preloadPath = null; }
  return _preloadPath;
}

/**
 * Inject the macOS process.title crash guard into a child env via NODE_OPTIONS.
 * No-op off macOS or if the preload can't be written; appends to any existing
 * NODE_OPTIONS (idempotent — won't double-add). See NO_TITLE_PRELOAD.
 */
export function withNodeTitleGuard(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  if (process.platform !== "darwin") return env;
  const p = noTitlePreloadPath();
  if (!p) return env;
  const flag = `--require ${p}`;
  const cur = env.NODE_OPTIONS;
  if (cur && cur.includes(flag)) return env;
  return { ...env, NODE_OPTIONS: cur ? `${cur} ${flag}` : flag };
}

/** Both spawn-env hardenings in one: drop host contamination AND guard against
 *  the process.title SIGSEGV. For the raw-`{...process.env}` build/scaffold spawn
 *  paths that don't use buildSanitizedEnv. */
export function hardenChildEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return withNodeTitleGuard(stripHostContaminationEnv(env));
}
