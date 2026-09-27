// A vault secret handed to a command reaches the process environment and
// nowhere the model can read. Live 2026-09-26: a working Supabase token could
// not deploy three functions because the shell had no route to the vault.
import { describe, it, expect, vi } from "vitest";

const VAULT: Record<string, string> = { SUPABASE_TOKEN: "sbp_0f1e2d3c4b5a69788796a5b4c3d2e1f00f1e2d3c" };
vi.mock("../secrets.js", () => ({ getSecretsStoreSingleton: () => ({ get: (name: string) => VAULT[name] }) }));

const { secretEnvOf, secretEnvProgram, resolveSecretEnv } = await import("./shell-secret-env.js");
const { bashTool } = await import("./shell-tool.js");

describe("secret_env arguments", () => {
  it("reads { ENV_VAR: SECRET_NAME } and rejects anything else by name", () => {
    expect(secretEnvOf({ command: "x" })).toBeNull();
    expect(secretEnvOf({ secret_env: {} })).toBeNull();
    expect(secretEnvOf({ secret_env: { SUPABASE_ACCESS_TOKEN: "SUPABASE_TOKEN" } })).toEqual({ SUPABASE_ACCESS_TOKEN: "SUPABASE_TOKEN" });
    expect(() => secretEnvOf({ secret_env: ["SUPABASE_TOKEN"] })).toThrow(/object/);
    expect(() => secretEnvOf({ secret_env: { "BAD-NAME": "SUPABASE_TOKEN" } })).toThrow(/environment variable/);
    expect(() => secretEnvOf({ secret_env: { TOKEN: "sbp_raw_value_pasted_in" } })).toThrow(/stored secret/);
  });

  it("names the program the way the user would", () => {
    expect(secretEnvProgram("npx supabase functions deploy food-search --project-ref abc")).toBe("npx supabase");
    expect(secretEnvProgram("FOO=1 gh pr list")).toBe("gh");
    expect(secretEnvProgram("/usr/local/bin/vercel deploy")).toBe("vercel");
  });

  it("resolves from the vault, reports a missing secret by name, and scrubs the value", () => {
    const ok = resolveSecretEnv({ SUPABASE_ACCESS_TOKEN: "SUPABASE_TOKEN" });
    if ("missing" in ok) throw new Error("unexpected missing");
    expect(ok.env).toEqual({ SUPABASE_ACCESS_TOKEN: VAULT.SUPABASE_TOKEN });
    expect(ok.scrub(`Authorization: Bearer ${VAULT.SUPABASE_TOKEN}`)).toBe("Authorization: Bearer [secret SUPABASE_TOKEN]");
    expect(resolveSecretEnv({ X: "NOT_STORED" })).toEqual({ missing: ["NOT_STORED"] });
  });
});

describe("bash with secret_env", () => {
  it("the command gets the value in its environment; the output never carries it", async () => {
    const result = await bashTool.execute({
      command: 'test -n "$SUPABASE_ACCESS_TOKEN" && echo "set, ${#SUPABASE_ACCESS_TOKEN} chars: $SUPABASE_ACCESS_TOKEN"',
      secret_env: { SUPABASE_ACCESS_TOKEN: "SUPABASE_TOKEN" },
    });
    const text = String(result.content);
    expect(text).toContain(`set, ${VAULT.SUPABASE_TOKEN.length} chars: [secret SUPABASE_TOKEN]`);
    expect(text).not.toContain(VAULT.SUPABASE_TOKEN);
  });

  it("a secret that is not stored stops the call and says how to get it", async () => {
    const result = await bashTool.execute({ command: "echo hi", secret_env: { T: "NOT_STORED" } });
    expect(result.isError).toBe(true);
    expect(String(result.content)).toMatch(/NOT_STORED.*request_secrets/);
  });
});
