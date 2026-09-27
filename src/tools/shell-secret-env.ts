/**
 * Vault secrets handed to ONE shell command as environment variables.
 *
 * A CLI that authenticates from its environment (`SUPABASE_ACCESS_TOKEN` for
 * the supabase CLI, `GH_TOKEN` for gh) had no route to a vault secret: a
 * `{{NAME}}` placeholder in the command text is refused, because resolving it
 * there would put the plaintext in argv, the progress tails and the logs. Live
 * 2026-09-26: a working Supabase token could not deploy three functions.
 *
 * `secret_env: { SUPABASE_ACCESS_TOKEN: "SUPABASE_FULL_TOKEN" }` puts the value
 * in the child's environment only — never the command text — and anything the
 * command prints has it replaced by `[secret NAME]` before the model sees it.
 * Whether the call needs the user's yes is the profile's `secrets` rule
 * (tool-execution/secret-env-approval.ts).
 */
import { getSecretsStoreSingleton } from "../secrets.js";
import { registerRedactedSecretValue } from "../security/secrets/known-secrets.js";

/** Environment variable name → vault secret name. */
export type SecretEnv = Record<string, string>;

const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const SECRET_NAME = /^[A-Z][A-Z0-9_]*$/;

/** The call's secret_env, or null when it has none. Throws on a malformed one
 *  so the model hears what to fix instead of running without the secret. */
export function secretEnvOf(args: Record<string, unknown>): SecretEnv | null {
  const raw = args.secret_env;
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== "object" || Array.isArray(raw)) throw new Error("secret_env must be an object of { ENV_VAR: SECRET_NAME }.");
  const entries = Object.entries(raw as Record<string, unknown>);
  if (entries.length === 0) return null;
  const out: SecretEnv = {};
  for (const [env, name] of entries) {
    if (!ENV_NAME.test(env)) throw new Error(`secret_env: "${env}" is not a valid environment variable name.`);
    if (typeof name !== "string" || !SECRET_NAME.test(name)) throw new Error(`secret_env.${env} must name a stored secret in SCREAMING_SNAKE_CASE.`);
    out[env] = name;
  }
  return out;
}

/** The program a command runs, as the user would name it: `npx supabase`,
 *  `gh`, `vercel`. Leading VAR=value assignments are skipped. */
export function secretEnvProgram(command: string): string {
  const words = command.trim().split(/\s+/).filter((w) => !/^\w+=/.test(w));
  const first = (words[0] ?? "").replace(/^.*[\\/]/, "");
  return ["npx", "pnpm", "pnpx", "yarn", "bunx", "uvx"].includes(first) && words[1] ? `${first} ${words[1]}` : first;
}

export interface ResolvedSecretEnv {
  env: Record<string, string>;
  scrub: (text: string) => string;
}

/** Read the named secrets from the vault. Missing ones are reported by name. */
export function resolveSecretEnv(secretEnv: SecretEnv): ResolvedSecretEnv | { missing: string[] } {
  const store = getSecretsStoreSingleton();
  const env: Record<string, string> = {};
  const values: Array<{ name: string; value: string }> = [];
  const missing: string[] = [];
  for (const [envName, secretName] of Object.entries(secretEnv)) {
    const value = store?.get(secretName);
    if (!value) { missing.push(secretName); continue; }
    env[envName] = value;
    values.push({ name: secretName, value });
    registerRedactedSecretValue(value);
  }
  if (missing.length > 0) return { missing };
  return {
    env,
    scrub: (text) => values.reduce((t, { name, value }) => t.split(value).join(`[secret ${name}]`), text),
  };
}
