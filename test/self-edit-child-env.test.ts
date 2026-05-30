/**
 * Tests for the self_edit child-env confidentiality scrub (child-env.ts).
 *
 * The security property under test: a prompt-injected `claude -p` child must
 * NOT inherit the user's credentials from the LAX server env. Only the
 * non-credential allowlist passes through, plus the child's own Anthropic
 * auth (so API-key installs still work).
 *
 * Pure logic — buildSelfEditChildEnv takes an injectable base env, so no
 * real process.env or spawned child is needed.
 */

import { describe, it, expect } from "vitest";
import { buildSelfEditChildEnv } from "../src/self-edit/child-env.js";

const BASE: NodeJS.ProcessEnv = {
  // Allowlisted, non-credential — must survive.
  PATH: "/usr/bin:/bin",
  HOME: "/home/user",
  USERPROFILE: "C:\\Users\\user",
  TEMP: "C:\\Temp",
  SYSTEMROOT: "C:\\Windows",
  // Credentials that have NOTHING to do with editing TypeScript — must be stripped.
  GITHUB_TOKEN: "ghp_should_be_stripped",
  AWS_SECRET_ACCESS_KEY: "aws_should_be_stripped",
  AWS_ACCESS_KEY_ID: "AKIA_should_be_stripped",
  STRIPE_SECRET_KEY: "sk_live_should_be_stripped",
  TWILIO_AUTH_TOKEN: "twilio_should_be_stripped",
  LAX_AUTH_TOKEN: "lax_should_be_stripped",
  SOME_RANDOM_SECRET: "should_be_stripped",
  CUSTOM_API_KEY: "should_be_stripped",
  DATABASE_URL: "postgres://should_be_stripped",
  // The child's own Anthropic auth — must pass through.
  ANTHROPIC_API_KEY: "sk-ant-keepme",
};

describe("buildSelfEditChildEnv", () => {
  it("passes through the non-credential allowlist", () => {
    const env = buildSelfEditChildEnv(BASE);
    expect(env.HOME).toBe("/home/user");
    expect(env.USERPROFILE).toBe("C:\\Users\\user");
    expect(env.TEMP).toBe("C:\\Temp");
    expect(env.SYSTEMROOT).toBe("C:\\Windows");
    // PATH is preserved (possibly with the npm global bin prepended).
    expect(env.PATH).toContain("/usr/bin:/bin");
  });

  it("strips every third-party / platform credential", () => {
    const env = buildSelfEditChildEnv(BASE);
    for (const key of [
      "GITHUB_TOKEN",
      "AWS_SECRET_ACCESS_KEY",
      "AWS_ACCESS_KEY_ID",
      "STRIPE_SECRET_KEY",
      "TWILIO_AUTH_TOKEN",
      "LAX_AUTH_TOKEN",
      "SOME_RANDOM_SECRET",
      "CUSTOM_API_KEY",
      "DATABASE_URL",
    ]) {
      expect(env[key], `${key} must be stripped`).toBeUndefined();
    }
  });

  it("passes through the child's own Anthropic auth so the child can authenticate", () => {
    const env = buildSelfEditChildEnv(BASE);
    expect(env.ANTHROPIC_API_KEY).toBe("sk-ant-keepme");
  });

  it("passes through CLAUDE_CODE_OAUTH_TOKEN when present", () => {
    const env = buildSelfEditChildEnv({ ...BASE, CLAUDE_CODE_OAUTH_TOKEN: "oauth-keepme" });
    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBe("oauth-keepme");
  });

  it("never leaks a credential even if it shares a name with nothing on the allowlist", () => {
    // A freshly-invented credential var name still gets caught by the
    // substring deny rules (_TOKEN / _SECRET / _KEY / _PASSWORD).
    const env = buildSelfEditChildEnv({
      PATH: "/bin",
      ACME_DEPLOY_TOKEN: "leak",
      SERVICE_PASSWORD: "leak",
      VENDOR_PRIVATE_KEY: "leak",
    });
    expect(env.ACME_DEPLOY_TOKEN).toBeUndefined();
    expect(env.SERVICE_PASSWORD).toBeUndefined();
    expect(env.VENDOR_PRIVATE_KEY).toBeUndefined();
  });

  it("emits no key that is not allowlisted or an exempt Anthropic auth var", () => {
    const env = buildSelfEditChildEnv(BASE);
    const allowed = new Set([
      "PATH", "PATHEXT", "HOME", "USERPROFILE", "SYSTEMROOT", "WINDIR", "COMSPEC",
      "APPDATA", "LOCALAPPDATA", "TMPDIR", "TEMP", "TMP", "LANG", "LC_ALL", "LC_CTYPE",
      "SHELL", "USER", "LOGNAME", "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_CACHE_HOME",
      "NODE_PATH", "ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "CLAUDE_CODE_OAUTH_TOKEN",
    ]);
    for (const key of Object.keys(env)) {
      expect(allowed.has(key), `unexpected key in scrubbed env: ${key}`).toBe(true);
    }
  });
});
