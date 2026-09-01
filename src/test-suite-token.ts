// Where the live integration suite (src/test-suite.ts) gets its auth token.
//
// Pure decision — environment, then the config file, then a classified
// failure — so it can be unit-tested without touching ~/.lax. That matters
// because ~/.lax is a hard deny inside the guarded bash sandbox
// (sandbox/validate.ts, HOME_RELATIVE_DENY_DIRS): an agent running `npm test`
// in the cage gets EPERM on config.json, which reads like a repo failure
// unless the suite says otherwise. The deny stays; the suite explains it.
//
// Truthfulness (the sandbox/denial-hints.ts invariant): the cage is named only
// as a possibility, and only on evidence — a permission errno on a path under
// a `.lax` dir. A chmod'd file anywhere else is reported as what it is. The raw
// fs message stays in the line so the harness's own cage notice
// (sandboxDenialHint, keyed on "operation not permitted" + "/.lax") still fires
// on top of it; the advice here matches that notice instead of competing.

import { AUTH_TOKEN_ENV } from "./config.js";

export type TokenResolution =
  | { ok: true; token: string; source: "env" | "file" }
  | { ok: false; reason: "sandbox" | "not-configured" | "unreadable"; message: string };

export interface TokenSources {
  /** Process environment, or a stand-in for tests. */
  env: Readonly<Record<string, string | undefined>>;
  /** Absolute path of the config file — shown in messages. */
  configPath: string;
  /** Reads the config file's raw text; throws the fs error on failure. */
  readConfig: (path: string) => string;
}

export function resolveToken(sources: TokenSources): TokenResolution {
  const fromEnv = sources.env[AUTH_TOKEN_ENV]?.trim();
  if (fromEnv) return { ok: true, token: fromEnv, source: "env" };

  let raw: string;
  try {
    raw = sources.readConfig(sources.configPath);
  } catch (err) {
    return classifyReadFailure(err, sources.configPath);
  }

  let cfg: unknown;
  try {
    cfg = JSON.parse(raw);
  } catch (err) {
    return {
      ok: false,
      reason: "unreadable",
      message: `cannot parse ${sources.configPath}: ${describe(err)}`,
    };
  }

  const fromFile = pickToken(cfg);
  if (fromFile) return { ok: true, token: fromFile, source: "file" };
  return {
    ok: false,
    reason: "not-configured",
    message: `${sources.configPath} has no auth token — set ${AUTH_TOKEN_ENV}, or add authToken to the file`,
  };
}

function classifyReadFailure(err: unknown, configPath: string): TokenResolution {
  const code = (err as NodeJS.ErrnoException).code;
  const detail = describe(err);
  if ((code === "EPERM" || code === "EACCES") && underLaxDir(configPath)) {
    return {
      ok: false,
      reason: "sandbox",
      message:
        `cannot read ${configPath}: ${detail} — if this is running inside the bash sandbox cage, ` +
        `that is the ~/.lax deny, not the code: run \`npm run test:unit\` in the cage, set ${AUTH_TOKEN_ENV}, ` +
        "or run `npm test` outside the sandbox (the user can turn the bash sandbox Off in " +
        "Settings → Security; offer that rather than disabling it yourself)",
    };
  }
  if (code === "ENOENT") {
    return {
      ok: false,
      reason: "not-configured",
      message: `no ${configPath} — set ${AUTH_TOKEN_ENV}, or run \`npm test\` where the server is configured`,
    };
  }
  return { ok: false, reason: "unreadable", message: `cannot read ${configPath}: ${detail}` };
}

// The same evidence sandboxDenialHint requires: a `.lax` path segment.
function underLaxDir(path: string): boolean {
  return /[\\/]\.lax[\\/]/.test(path);
}

// `token` first, then `authToken` — the order the suite has always used.
function pickToken(cfg: unknown): string {
  if (typeof cfg !== "object" || cfg === null) return "";
  const { token, authToken } = cfg as { token?: unknown; authToken?: unknown };
  const picked = typeof token === "string" ? token : typeof authToken === "string" ? authToken : "";
  return picked.trim();
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
