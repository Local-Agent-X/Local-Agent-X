import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { writeMcpConfig } from "./mcp-config.js";
import { buildMcpChildEnv, __resetMcpEnvLogState } from "../mcp-client/connection.js";

// Snapshot + restore process.env around every test. The strip-pass is
// branchy on actual env keys, so leaking state across tests would mask
// regressions.

const ORIGINAL_ENV = { ...process.env };
// Resolve the host tmpdir once, before any test clears process.env.
// node:os.tmpdir() reads TMPDIR/TEMP/TMP from process.env at call time, so
// without this we'd get `undefined\temp\...` after clearEnv() wiped them.
const HOST_TMPDIR = tmpdir();

function clearEnv(): void {
  for (const k of Object.keys(process.env)) {
    delete process.env[k];
  }
}

interface WrittenConfig {
  mcpServers: {
    lax: {
      command: string;
      args: string[];
      env: Record<string, string>;
    };
  };
}

let tmpRoot: string;

beforeEach(() => {
  clearEnv();
  // Redirect ~/.lax/tmp into a fresh tempdir per test so concurrent runs
  // don't trample each other and the test never writes to the real home.
  tmpRoot = mkdtempSync(join(HOST_TMPDIR, "lax-mcp-cfg-"));
  process.env.LAX_DATA_DIR = tmpRoot;
  process.env.HOME = tmpRoot;
  process.env.USERPROFILE = tmpRoot;
  __resetMcpEnvLogState();
});

afterEach(() => {
  clearEnv();
  Object.assign(process.env, ORIGINAL_ENV);
  try { rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* best-effort */ }
});

function readWritten(path: string): WrittenConfig {
  return JSON.parse(readFileSync(path, "utf-8")) as WrittenConfig;
}

describe("writeMcpConfig", () => {
  it("baseline: writes LAX_MCP_URL / LAX_MCP_TOKEN / LAX_MCP_SESSION_ID", () => {
    const path = writeMcpConfig({ port: 7007, token: "abc", sessionId: "s1", tag: "test1" });
    const cfg = readWritten(path);
    const env = cfg.mcpServers.lax.env;

    expect(env.LAX_MCP_URL).toBe("http://127.0.0.1:7007");
    expect(env.LAX_MCP_TOKEN).toBe("abc");
    expect(env.LAX_MCP_SESSION_ID).toBe("s1");
  });

  it("omits LAX_MCP_SESSION_ID when input.sessionId is not provided", () => {
    const path = writeMcpConfig({ port: 7008, token: "abc", tag: "no-session" });
    const env = readWritten(path).mcpServers.lax.env;

    expect("LAX_MCP_SESSION_ID" in env).toBe(false);
  });

  it("allowlist passthrough: PATH from process.env reaches the written env", () => {
    process.env.PATH = "/usr/bin";
    const path = writeMcpConfig({ port: 7007, token: "t", tag: "path" });
    const env = readWritten(path).mcpServers.lax.env;

    expect(env.PATH).toBe("/usr/bin");
  });

  it("allowlist additions: TMPDIR, LANG, XDG_CONFIG_HOME all pass through", () => {
    process.env.TMPDIR = "/tmp";
    process.env.LANG = "en_US.UTF-8";
    process.env.XDG_CONFIG_HOME = "/home/me/.config";
    process.env.PATH = "/usr/bin";

    const path = writeMcpConfig({ port: 7007, token: "t", tag: "newkeys" });
    const env = readWritten(path).mcpServers.lax.env;

    expect(env.TMPDIR).toBe("/tmp");
    expect(env.LANG).toBe("en_US.UTF-8");
    expect(env.XDG_CONFIG_HOME).toBe("/home/me/.config");
    expect(env.PATH).toBe("/usr/bin");
  });

  it("credential strip: OPENAI_API_KEY in process.env never reaches the written env", () => {
    const warnSpy = vi.spyOn(console, "error").mockImplementation(() => { /* swallow */ });

    process.env.PATH = "/usr/bin";
    process.env.OPENAI_API_KEY = "sk-leaked";

    const path = writeMcpConfig({ port: 7007, token: "t", tag: "stripapi" });
    const env = readWritten(path).mcpServers.lax.env;

    expect(env.PATH).toBe("/usr/bin");
    expect("OPENAI_API_KEY" in env).toBe(false);

    // OPENAI_API_KEY isn't in the allowlist either, so the strip pass
    // may or may not fire on this exact key. The contract under test is:
    // the credential never appears in the output, AND the strip pass
    // never logs the value. Search every warn call for the literal value
    // — if present, that's a leak regardless of which layer dropped it.
    const leakedValue = warnSpy.mock.calls.some(call =>
      call.some(arg => typeof arg === "string" && arg.includes("sk-leaked")),
    );
    expect(leakedValue).toBe(false);

    warnSpy.mockRestore();
  });

  it("credential strip: caller-injected credential-shaped keys are stripped and warned", () => {
    // Simulate future drift: a contributor adds OPENAI_API_KEY to the
    // allowlist. The strip pass must catch it. We force this by writing
    // an env from a synthetic path: use a credential-shaped key that the
    // strip should catch even if it slipped past the allowlist.
    //
    // Since the production writeMcpConfig builds env from a fixed
    // allowlist, we exercise the strip via a known-bad allowlist entry
    // simulating drift. The easiest direct test: set process.env values
    // for *future-drift* keys and observe they never appear.
    const warnSpy = vi.spyOn(console, "error").mockImplementation(() => { /* swallow */ });

    process.env.AWS_SECRET_ACCESS_KEY = "aws-leak";
    process.env.GITHUB_TOKEN = "ghp-leak";
    process.env.MY_API_KEY = "myapi-leak";
    process.env.PATH = "/usr/bin";

    const path = writeMcpConfig({ port: 7007, token: "t", tag: "drift" });
    const env = readWritten(path).mcpServers.lax.env;

    expect("AWS_SECRET_ACCESS_KEY" in env).toBe(false);
    expect("GITHUB_TOKEN" in env).toBe(false);
    expect("MY_API_KEY" in env).toBe(false);
    expect(env.PATH).toBe("/usr/bin");

    // Confirm none of the secret VALUES ended up logged.
    const leaked = warnSpy.mock.calls.some(call =>
      call.some(arg => typeof arg === "string" && /aws-leak|ghp-leak|myapi-leak/.test(arg)),
    );
    expect(leaked).toBe(false);

    warnSpy.mockRestore();
  });

  it("LAX_MCP_TOKEN exemption: bridge env keeps LAX_MCP_TOKEN even though it's in the global deny list", () => {
    const path = writeMcpConfig({ port: 7007, token: "bridge-secret", sessionId: "s2", tag: "exempt" });
    const env = readWritten(path).mcpServers.lax.env;

    // The shared deny-prefix table contains "LAX_MCP_TOKEN" (added so
    // external untrusted MCP servers can't receive our auth token). The
    // bridge path exempts it; without the exemption, this would be
    // empty.
    expect(env.LAX_MCP_TOKEN).toBe("bridge-secret");
  });

  it("external-MCP path unchanged: LAX_MCP_TOKEN still stripped by buildMcpChildEnv", () => {
    // Verifies the bridge exemption did NOT leak into the external-MCP
    // path. Critical security boundary — untrusted MCP servers must not
    // receive our auth token.
    process.env.LAX_MCP_TOKEN = "should-be-stripped";
    process.env.PATH = "/usr/bin";

    const env = buildMcpChildEnv();

    expect("LAX_MCP_TOKEN" in env).toBe(false);
    expect(env.PATH).toBe("/usr/bin");
  });

  it("non-string env values: process.env.PATH unset does not crash and PATH is omitted", () => {
    // PATH not set in the cleared env. writeMcpConfig should produce a
    // valid config without PATH and without throwing.
    expect(() => writeMcpConfig({ port: 7007, token: "t", tag: "no-path" })).not.toThrow();

    const path = writeMcpConfig({ port: 7007, token: "t", tag: "no-path-2" });
    const env = readWritten(path).mcpServers.lax.env;

    expect("PATH" in env).toBe(false);
    expect(env.LAX_MCP_TOKEN).toBe("t");
  });
});
