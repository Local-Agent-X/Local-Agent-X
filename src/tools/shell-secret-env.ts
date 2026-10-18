/**
 * Vault secrets handed to ONE command as environment variables: a bash call,
 * or a background process (process_start / process_restart).
 *
 * A CLI that authenticates from its environment (`SUPABASE_ACCESS_TOKEN` for
 * the supabase CLI, `GH_TOKEN` for gh) had no route to a vault secret: a
 * `{{NAME}}` placeholder in the command text is refused, because resolving it
 * there would put the plaintext in argv, the progress tails and the logs. Live
 * 2026-09-26: a working Supabase token could not deploy three functions.
 *
 * `secret_env: { SUPABASE_ACCESS_TOKEN: "SUPABASE_FULL_TOKEN" }` puts the value
 * in the child's environment only — never the command text — and anything the
 * command prints has it replaced by `[secret NAME]` before the model sees it
 * (a background process's buffers are scrubbed on every read, process-session.ts).
 * Whether the call needs the user's yes is the profile's `secrets` rule
 * (tool-execution/secret-env-approval.ts).
 *
 * A media provider's API key (OPENAI_API_KEY, XAI_API_KEY) is not handed over
 * while paid API keys for images and video are off: a command holding it could
 * buy images or video on it, and the shell's egress proxy sees only the host of
 * a TLS call, so the route cannot be judged where the traffic leaves.
 */
import { getSecretsStoreSingleton } from "../secrets.js";
import { registerRedactedSecretValue, vaultSecretSource } from "../security/secrets/known-secrets.js";
import { TOOL_POLICIES } from "../tool-policy/tool-policies.js";
import { PAID_MEDIA_KEY_PROVIDERS, paidMediaApisAllowed, paidMediaKeyProvider, paidMediaOffMessage } from "./image-tools/paid-media.js";

/** Environment variable name → vault secret name. */
export type SecretEnv = Record<string, string>;

/** Every tool that takes secret_env, as its row declares (`secretEnv`). Its
 *  approval card (secretEnvGate) and the outbound-block recovery that points at
 *  it key on this one set; a tool whose schema declares the parameter without
 *  the row fact fails tool-registration-completeness.test.ts. */
export const SECRET_ENV_TOOLS: ReadonlySet<string> = new Set(Object.keys(TOOL_POLICIES).filter((name) => TOOL_POLICIES[name].secretEnv === true));

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
  /** scrub, plus a value cut off at the end of the text: output read while the
   *  process is still writing, or clipped at a buffer cap, can stop mid-value. */
  scrubOpenEnded: (text: string) => string;
}

// A cut-off value shorter than this is left alone: a few leading characters say
// nothing about the secret, and masking them would garble ordinary output.
const MIN_CUT_OFF = 4;

/** The refusal for secrets the vault does not hold, in one wording for every tool. */
function missingSecretEnvMessage(missing: string[]): string {
  return `secret_env: not in the vault: ${missing.join(", ")}. Ask the user for it with request_secrets, then retry.`;
}

/** The refusal when a named secret is a media provider's per-use-billed API
 *  key and paid API keys for images and video are off; null otherwise. The
 *  same switch generate_image and http_request answer to. */
export function paidMediaSecretEnvRefusal(secretEnv: SecretEnv): string | null {
  if (paidMediaApisAllowed()) return null;
  const store = getSecretsStoreSingleton();
  for (const secretName of new Set(Object.values(secretEnv))) {
    const provider = paidMediaKeyProvider(secretName, store?.get(secretName), store);
    if (!provider) continue;
    const kind = PAID_MEDIA_KEY_PROVIDERS[provider];
    return `secret_env: ${secretName} is a per-use-billed ${kind} API key, and a command holding it could spend it. ${paidMediaOffMessage(kind)}`;
  }
  return null;
}

/** Read the named secrets from the vault. A refusal names the missing
 *  secrets, or the paid media key the switch keeps from the shell. */
export function resolveSecretEnv(secretEnv: SecretEnv): ResolvedSecretEnv | { refusal: string } {
  const paidMedia = paidMediaSecretEnvRefusal(secretEnv);
  if (paidMedia) return { refusal: paidMedia };
  const store = getSecretsStoreSingleton();
  const env: Record<string, string> = {};
  const values: Array<{ name: string; value: string }> = [];
  const missing: string[] = [];
  for (const [envName, secretName] of Object.entries(secretEnv)) {
    const value = store?.get(secretName);
    if (!value) { missing.push(secretName); continue; }
    env[envName] = value;
    values.push({ name: secretName, value });
    registerRedactedSecretValue(value, vaultSecretSource(secretName));
  }
  if (missing.length > 0) return { refusal: missingSecretEnvMessage(missing) };
  const scrub = (text: string): string => values.reduce((t, { name, value }) => t.split(value).join(`[secret ${name}]`), text);
  const scrubOpenEnded = (text: string): string => {
    const t = scrub(text);
    for (const { name, value } of values) {
      for (let n = Math.min(value.length - 1, t.length); n >= MIN_CUT_OFF; n--) {
        if (t.endsWith(value.slice(0, n))) return `${t.slice(0, -n)}[secret ${name}]`;
      }
    }
    return t;
  };
  return { env, scrub, scrubOpenEnded };
}
