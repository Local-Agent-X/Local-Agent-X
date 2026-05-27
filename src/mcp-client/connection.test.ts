import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { buildMcpChildEnv, __resetMcpEnvLogState } from "./connection.js";

// Snapshot + restore process.env around every test so a leaked variable
// from one case (e.g. a planted ANTHROPIC_API_KEY) cannot influence
// another. Vitest gives each file its own process.env reference but the
// scoping inside a single file is still our problem.

const ORIGINAL_ENV = { ...process.env };

function clearEnv(): void {
  for (const k of Object.keys(process.env)) {
    delete process.env[k];
  }
}

beforeEach(() => {
  clearEnv();
  __resetMcpEnvLogState();
});

afterEach(() => {
  clearEnv();
  Object.assign(process.env, ORIGINAL_ENV);
});

describe("buildMcpChildEnv", () => {
  it("returns only allowlisted keys from process.env when no configEnv passed", () => {
    process.env.PATH = "/usr/bin:/bin";
    process.env.HOME = "/home/test";
    process.env.RANDOM_HARMLESS_VAR = "1";
    process.env.ANTHROPIC_API_KEY = "sk-ant-leak";

    const env = buildMcpChildEnv();

    expect(env.PATH).toBe("/usr/bin:/bin");
    expect(env.HOME).toBe("/home/test");
    expect(env.RANDOM_HARMLESS_VAR).toBeUndefined();
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
  });

  it("never leaks ANTHROPIC_API_KEY even when set in process.env", () => {
    process.env.ANTHROPIC_API_KEY = "sk-ant-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx";
    process.env.PATH = "/usr/bin";

    const env = buildMcpChildEnv();

    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
    expect("ANTHROPIC_API_KEY" in env).toBe(false);
  });

  it("passes through harmless per-server grants alongside the allowlist", () => {
    process.env.PATH = "/usr/bin";

    const env = buildMcpChildEnv({ MY_SERVER_FLAG: "x", FEATURE_MODE: "fast" });

    expect(env.PATH).toBe("/usr/bin");
    expect(env.MY_SERVER_FLAG).toBe("x");
    expect(env.FEATURE_MODE).toBe("fast");
  });

  it("strips OPENAI_API_KEY from configEnv and logs a warn", () => {
    const warnSpy = vi.spyOn(console, "error").mockImplementation(() => { /* swallow */ });

    process.env.PATH = "/usr/bin";
    const env = buildMcpChildEnv({ OPENAI_API_KEY: "sk-leaked" });

    expect(env.OPENAI_API_KEY).toBeUndefined();
    expect("OPENAI_API_KEY" in env).toBe(false);

    // logger.warn routes to console.error
    const warned = warnSpy.mock.calls.some(call =>
      call.some(arg => typeof arg === "string" && arg.includes("OPENAI_API_KEY")),
    );
    expect(warned).toBe(true);

    warnSpy.mockRestore();
  });

  it("strips credential-prefix keys: ANTHROPIC_FOO, AWS_REGION, STRIPE_KEY, GITHUB_TOKEN", () => {
    const env = buildMcpChildEnv({
      ANTHROPIC_FOO: "x",
      AWS_REGION: "us-east-1",
      STRIPE_KEY: "sk_test",
      GITHUB_TOKEN: "ghp_xxx",
      SAFE_FLAG: "ok",
    });

    expect(env.ANTHROPIC_FOO).toBeUndefined();
    expect(env.AWS_REGION).toBeUndefined();
    expect(env.STRIPE_KEY).toBeUndefined();
    expect(env.GITHUB_TOKEN).toBeUndefined();
    expect(env.SAFE_FLAG).toBe("ok");
  });

  it("strips credential-substring keys: MY_SECRET_TOKEN, THIRDPARTY_PASSWORD, FOO_PRIVATE_KEY", () => {
    const env = buildMcpChildEnv({
      MY_SECRET_TOKEN: "abc",
      THIRDPARTY_PASSWORD: "hunter2",
      FOO_PRIVATE_KEY: "-----BEGIN-----",
      JUST_A_FLAG: "fine",
    });

    expect(env.MY_SECRET_TOKEN).toBeUndefined();
    expect(env.THIRDPARTY_PASSWORD).toBeUndefined();
    expect(env.FOO_PRIVATE_KEY).toBeUndefined();
    expect(env.JUST_A_FLAG).toBe("fine");
  });

  it("default-deny: harmless non-allowlisted key in process.env does NOT pass through", () => {
    process.env.RANDOM_HARMLESS_VAR = "1";
    process.env.SOME_OTHER_THING = "value";

    const env = buildMcpChildEnv();

    expect(env.RANDOM_HARMLESS_VAR).toBeUndefined();
    expect(env.SOME_OTHER_THING).toBeUndefined();
  });

  it("returns {} when process.env is empty and no configEnv given", () => {
    const env = buildMcpChildEnv();
    expect(env).toEqual({});
  });

  it("returns only the configEnv (minus credentials) when process.env is empty", () => {
    const env = buildMcpChildEnv({ FOO: "bar", DB_PASSWORD: "shh" });
    expect(env).toEqual({ FOO: "bar" });
  });

  it("hard-strips credential prefixes case-insensitively", () => {
    const env = buildMcpChildEnv({
      anthropic_api_key: "lowercase-leak",
      Aws_Region: "mixed-case",
    });
    expect(env.anthropic_api_key).toBeUndefined();
    expect(env.Aws_Region).toBeUndefined();
  });

  it("caller grants override allowlist values for non-credential keys", () => {
    process.env.PATH = "/system/bin";
    const env = buildMcpChildEnv({ PATH: "/custom/bin" });
    expect(env.PATH).toBe("/custom/bin");
  });
});
