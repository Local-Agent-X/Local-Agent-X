import { homedir } from "node:os";

import type { MCPServerConfig } from "./types.js";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);

/**
 * Secret lookup is INJECTABLE so unit tests can drive it without booting
 * the real vault. Default delegates to the secrets-store singleton if it
 * exists; tests overwrite via `setSecretLookup` to drive deterministic
 * scenarios.
 *
 * Lazy delegation also handles bootstrap order — the MCP manager is
 * instantiated before the vault is guaranteed to exist (test envs, fresh
 * installs, CLI bootstrap). A missing vault yields `undefined` instead of
 * crashing the manager.
 */
type SecretLookup = (name: string) => string | undefined;

const defaultLookup: SecretLookup = (name: string) => {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const mod = require("../secrets.js") as { getSecretsStoreSingleton?: () => { get(n: string): string | undefined } | null };
    const store = mod.getSecretsStoreSingleton?.();
    return store?.get(name);
  } catch {
    return undefined;
  }
};

let secretLookup: SecretLookup = defaultLookup;

/** Test seam: override the secret-resolution function. Pass `null` to reset. */
export function setSecretLookup(fn: SecretLookup | null): void {
  secretLookup = fn ?? defaultLookup;
}

function lookupSecret(name: string): string | undefined {
  return secretLookup(name);
}

/**
 * Expand `${...}` placeholders in a config string. Supported forms:
 *   - `${HOME}` / `${USERPROFILE}` — OS home directory (portable across machines)
 *   - `${secret:NAME}` — read from the encrypted secrets vault
 *   - `~/` prefix — also expands to home directory
 *
 * Deliberately does NOT expand bare `$VAR` or `$(cmd)` — only the explicit
 * `${...}` form. This blocks shell-style injection from a config file an
 * attacker might tamper with: `command: "$(rm -rf /)"` would be passed
 * through verbatim, never evaluated.
 *
 * Returns the expanded string AND a list of placeholders that couldn't be
 * resolved (e.g. `${secret:MISSING}` when the vault has no MISSING). Callers
 * use the `missing` list to decide whether to skip starting a server with
 * unresolved required env.
 */
export function expandPlaceholders(input: string): { value: string; missing: string[] } {
  if (typeof input !== "string") return { value: input, missing: [] };
  const missing: string[] = [];
  let out = input;

  // 1. `~/` prefix → home dir (POSIX convention, also works on Windows).
  if (out.startsWith("~/") || out.startsWith("~\\")) {
    out = homedir() + out.slice(1);
  }

  // 2. ${HOME} / ${USERPROFILE} — OS home dir
  out = out.replace(/\$\{HOME\}/g, () => homedir());
  out = out.replace(/\$\{USERPROFILE\}/g, () => process.env.USERPROFILE || homedir());

  // 3. ${secret:NAME} — vault lookup. Anything still missing after lookup
  //    is reported back to the caller via `missing`; we leave the original
  //    placeholder in the string so logs surface the unresolved name
  //    instead of an empty value silently injected.
  out = out.replace(/\$\{secret:([A-Z0-9_]+)\}/g, (match, name: string) => {
    const v = lookupSecret(name);
    if (v) return v;
    missing.push(name);
    return match;
  });

  return { value: out, missing };
}

export function expandPlaceholdersDeep(
  config: MCPServerConfig,
): { config: MCPServerConfig; missing: string[] } {
  const allMissing: string[] = [];
  const args = (config.args || []).map(a => {
    const r = expandPlaceholders(a);
    allMissing.push(...r.missing);
    return r.value;
  });
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(config.env || {})) {
    const r = expandPlaceholders(v);
    allMissing.push(...r.missing);
    env[k] = r.value;
  }
  const cmd = expandPlaceholders(config.command);
  allMissing.push(...cmd.missing);
  return {
    config: { ...config, command: cmd.value, args, env },
    missing: Array.from(new Set(allMissing)),
  };
}
