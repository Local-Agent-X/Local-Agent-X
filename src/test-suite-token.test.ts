import { describe, it, expect } from "vitest";
import { resolveToken, type TokenSources } from "./test-suite-token.js";
import { AUTH_TOKEN_ENV } from "./config.js";
import { sandboxDenialHint } from "./sandbox/denial-hints.js";

const CONFIG = "/home/someone/.lax/config.json";
const OUTSIDE = "/srv/other/config.json";

// Node's real fs message shapes — the canonical cage notice keys on them.
const FS_MESSAGES: Record<string, string> = {
  EPERM: "operation not permitted",
  EACCES: "permission denied",
  ENOENT: "no such file or directory",
  EISDIR: "illegal operation on a directory",
};

function fsError(code: string, path: string): NodeJS.ErrnoException {
  return Object.assign(new Error(`${code}: ${FS_MESSAGES[code]}, open '${path}'`), { code });
}

function throwing(code: string, path = CONFIG): () => string {
  return () => { throw fsError(code, path); };
}

interface Harness {
  sources: TokenSources;
  reads: () => number;
}

function harness(
  env: Record<string, string | undefined>,
  read: () => string,
  configPath = CONFIG,
): Harness {
  let reads = 0;
  return {
    sources: {
      env,
      configPath,
      readConfig: () => { reads += 1; return read(); },
    },
    reads: () => reads,
  };
}

describe("resolveToken", () => {
  it("takes the token from the environment before touching the config file", () => {
    const h = harness({ [AUTH_TOKEN_ENV]: "env-tok" }, throwing("EPERM"));
    expect(resolveToken(h.sources)).toEqual({ ok: true, token: "env-tok", source: "env" });
    expect(h.reads()).toBe(0);
  });

  it("trims the env value and treats a blank one as unset", () => {
    const h = harness({ [AUTH_TOKEN_ENV]: "   " }, () => JSON.stringify({ token: "file-tok" }));
    expect(resolveToken(h.sources)).toEqual({ ok: true, token: "file-tok", source: "file" });
    expect(h.reads()).toBe(1);
  });

  it("falls back to the config file's token when the env is unset", () => {
    const h = harness({}, () => JSON.stringify({ token: "file-tok" }));
    expect(resolveToken(h.sources)).toEqual({ ok: true, token: "file-tok", source: "file" });
  });

  it("honors authToken when token is absent", () => {
    const h = harness({}, () => JSON.stringify({ authToken: "auth-tok" }));
    expect(resolveToken(h.sources)).toEqual({ ok: true, token: "auth-tok", source: "file" });
  });

  it("names the sandbox as a possibility on EPERM under ~/.lax, in one line", () => {
    const r = resolveToken(harness({}, throwing("EPERM")).sources);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe("sandbox");
    expect(r.message).toContain("if this is running inside the bash sandbox cage");
    expect(r.message).toContain("not the code");
    expect(r.message).toContain("`npm run test:unit` in the cage");
    expect(r.message).toContain(`set ${AUTH_TOKEN_ENV}`);
    expect(r.message).toContain("`npm test` outside the sandbox");
    expect(r.message).toContain("offer that rather than disabling it yourself");
    expect(r.message).not.toContain("\n");
  });

  it("keeps the raw fs message so the harness's canonical cage notice still fires", () => {
    for (const code of ["EPERM", "EACCES"]) {
      const r = resolveToken(harness({}, throwing(code)).sources);
      expect(r).toMatchObject({ ok: false, reason: "sandbox" });
      if (r.ok) return;
      expect(r.message).toContain(`${code}: ${FS_MESSAGES[code]}, open '${CONFIG}'`);
      expect(sandboxDenialHint("guarded", r.message)).not.toBeNull();
    }
  });

  it("does not blame the sandbox for a permission error outside ~/.lax", () => {
    const r = resolveToken(harness({}, throwing("EACCES", OUTSIDE), OUTSIDE).sources);
    expect(r).toMatchObject({ ok: false, reason: "unreadable" });
    if (r.ok) return;
    expect(r.message).toContain(`cannot read ${OUTSIDE}: EACCES: permission denied`);
    expect(r.message).not.toContain("sandbox");
    expect(sandboxDenialHint("guarded", r.message)).toBeNull();
  });

  it("reports ENOENT as plainly not configured, without blaming the sandbox", () => {
    const r = resolveToken(harness({}, throwing("ENOENT")).sources);
    expect(r).toMatchObject({ ok: false, reason: "not-configured" });
    if (r.ok) return;
    expect(r.message).toContain(CONFIG);
    expect(r.message).toContain(AUTH_TOKEN_ENV);
    expect(r.message).not.toContain("sandbox");
  });

  it("reports a config with no token as not configured", () => {
    const r = resolveToken(harness({}, () => JSON.stringify({ port: 7007 })).sources);
    expect(r).toMatchObject({ ok: false, reason: "not-configured" });
    if (r.ok) return;
    expect(r.message).toContain("has no auth token");
  });

  it("reports an unparseable config as unreadable, not as the sandbox", () => {
    const r = resolveToken(harness({}, () => "{not json").sources);
    expect(r).toMatchObject({ ok: false, reason: "unreadable" });
    if (r.ok) return;
    expect(r.message).toContain(`cannot parse ${CONFIG}`);
  });

  it("reports an unexpected fs error as unreadable with its message", () => {
    const r = resolveToken(harness({}, throwing("EISDIR")).sources);
    expect(r).toMatchObject({ ok: false, reason: "unreadable" });
    if (r.ok) return;
    expect(r.message).toContain("EISDIR");
  });
});
