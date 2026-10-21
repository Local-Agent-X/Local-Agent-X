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
import { execBasename, shellSegments, tokenizeCommand } from "../security/layer/shell-lex.js";
import { inlinePrograms } from "../security/layer/shell-inline-destinations.js";
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
  /** Why the command's output goes to the user instead of the model
   *  (secretManipulation), or null when the command only hands the secret on. */
  withheld: string | null;
}

// ── A command that works ON a secret's value, not one that hands it to a program ──
//
// The scrub above recognises the whole value. A command that slices, encodes,
// reverses or prints the value can put it in its output in pieces the scrub
// cannot recognise, so "never to the model" cannot be kept by reading the
// output; it is kept by reading the COMMAND, which the user sees on the card:
// a command that works on the value in its own text has its output delivered
// to the user, not the model (shell-tool.ts, process-session.ts). A program
// that merely receives the value (`gh`, `curl -H "… $TOKEN"`, a leading
// `VAR=$TOKEN cmd`) is the sanctioned use and runs as before. Not judged here:
// a script on disk that the command runs, which the card cannot show either.

const PRINTERS = new Set(["echo", "printf", "print", "cat", "write-output", "write-host", "write-information", "write-verbose", "write-warning", "write-error", "out-string", "out-file", "set-content", "add-content"]);
const ENV_READERS = /\b(?:environ|getenv|process\.env|Deno\.env|Bun\.env|\$ENV\{|ENV\[|GetEnvironmentVariables?)\b/;
const ASSIGNMENT = /(?:^|[\s;&|(])(?:export\s+|set\s+)?\$?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*("[^"]*"|'[^']*'|\S*)/g;

/** `$V`, `${V}`, `${V...}`, `%V%`, `$env:V`, `${env:V}`, `$Env:V`. */
function references(variable: string): RegExp {
  return new RegExp(`\\$\\{?(?:env:)?${variable}\\b|%${variable}(?::|%)`, "i");
}

/** The secret_env variables plus every variable assigned from one in the
 *  command (`X=$TOKEN`, `$x = $env:TOKEN`): working on the copy is working on
 *  the value. */
function secretVariables(command: string, names: string[]): string[] {
  const vars = new Set(names);
  for (let grew = true; grew;) {
    grew = false;
    for (const m of command.matchAll(ASSIGNMENT)) {
      if (vars.has(m[1])) continue;
      if ([...vars].some((v) => references(v).test(m[2]))) { vars.add(m[1]); grew = true; }
    }
  }
  return [...vars];
}

// A shell told to run a string runs the same judgment on it: `sh -c 'echo
// $TOKEN'` prints the value as surely as `echo $TOKEN` does.
const SHELLS = new Set(["sh", "bash", "zsh", "dash", "ksh", "fish", "pwsh", "powershell", "cmd"]);
const SHELL_BODY_FLAGS = new Set(["-c", "-command", "/c", "/k"]);
const ENCODED_BODY_FLAGS = new Set(["-e", "-ec", "-encodedcommand"]);

function nestedShellBody(verb: string, tokens: string[]): string | null {
  if (!SHELLS.has(verb)) return null;
  const at = tokens.findIndex((t, i) => i > 0 && SHELL_BODY_FLAGS.has(t.toLowerCase()));
  return at > 0 && tokens[at + 1] !== undefined ? tokens.slice(at + 1).join(" ") : null;
}

/** A PowerShell body handed over base64-encoded: the card cannot show it. */
function encodedShellBody(verb: string, tokens: string[]): boolean {
  return (verb === "pwsh" || verb === "powershell") && tokens.some((t, i) => i > 0 && ENCODED_BODY_FLAGS.has(t.toLowerCase()));
}

/** The command a segment runs, past its leading `VAR=value` words and an
 *  `env [-flags] [VAR=value…]` prefix: `GH_TOKEN=$TOKEN gh …` and
 *  `env FOO=1 echo $TOKEN` are judged as `gh` and `echo`. */
function effectiveTokens(tokens: string[]): string[] {
  let i = 0;
  while (i < tokens.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[i])) i++;
  if (i < tokens.length && execBasename(tokens[i]) === "env") {
    i++;
    while (i < tokens.length && (/^-/.test(tokens[i]) || /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[i]))) i++;
    // `env` with nothing left to run prints the environment: keep it as the verb.
    if (i === tokens.length) return ["env"];
  }
  return tokens.slice(i);
}

function dumpsEnvironment(verb: string, tokens: string[]): boolean {
  if (verb === "env" || verb === "printenv") return true;
  if (verb === "set" && tokens.length === 1) return true;
  if ((verb === "export" || verb === "declare") && tokens.some((t) => t === "-p" || t === "-x")) return true;
  return ["get-childitem", "gci", "dir", "ls", "get-item", "gi"].includes(verb) && tokens.some((t) => /^env:/i.test(t));
}

// A here-document is command text too (the card shows it), and its lines are
// the program's input: `cat <<EOF … $TOKEN … EOF` prints the value, and
// `python - <<EOF … os.environ … EOF` is inline code by another spelling.
const HEREDOC = /<<-?\s*['"]?\w/;

/**
 * Why a command works on a secret's value in its own text — slicing or
 * rewriting it, printing it, reading the environment in inline code, dumping
 * the environment — as a sentence naming the variable; null when it only
 * hands the value to a program.
 */
export function secretManipulation(command: string, secretEnv: SecretEnv): string | null {
  const vars = secretVariables(command, Object.keys(secretEnv));
  for (const v of vars) {
    // `${V:-default}`, `${V:?msg}`, `${V:+alt}` and `${V:=default}` test the
    // value; `${V:0:4}` and the other operators work on it.
    const rewritten = new RegExp(`\\$\\{${v}(?::(?![-?+=])|[#%/^,@])|\\$\\{(?:env:)?${v}\\}\\s*[.\\[]|\\$env:${v}\\s*(?:[.\\[]|-split|-replace|-join)|%${v}:~`, "i");
    if (rewritten.test(command)) return `this command slices or rewrites $${v}`;
  }
  if (HEREDOC.test(command)) {
    const named = vars.find((v) => references(v).test(command));
    if (named) return `this command feeds $${named} to a program through a here-document`;
    if (ENV_READERS.test(command)) return "this command reads the environment in a here-document program";
  }
  for (const segment of shellSegments(command)) {
    const tokens = effectiveTokens(tokenizeCommand(segment.text));
    if (tokens.length === 0) continue;
    const verb = execBasename(tokens[0]);
    const named = vars.find((v) => references(v).test(segment.text));
    if (named && (PRINTERS.has(verb) || /<<</.test(segment.text))) return `this command prints or writes out $${named}`;
    if (dumpsEnvironment(verb, tokens)) return "this command dumps the environment";
    if (encodedShellBody(verb, tokens)) return "this command runs an encoded script the card cannot show";
    const body = nestedShellBody(verb, tokens);
    const nested = body === null ? null : secretManipulation(body, Object.fromEntries(vars.map((v) => [v, secretEnv[v] ?? "SECRET"])));
    if (nested) return nested;
  }
  for (const body of inlinePrograms(command)) {
    const named = vars.find((v) => new RegExp(`\\b${v}\\b`).test(body));
    if (named || ENV_READERS.test(body)) return `this command reads ${named ? `$${named}` : "the environment"} in inline code`;
  }
  return null;
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
 *  secrets, or the paid media key the switch keeps from the shell. With the
 *  command, `withheld` says whether its output is the user's, not the model's. */
export function resolveSecretEnv(secretEnv: SecretEnv, command?: string): ResolvedSecretEnv | { refusal: string } {
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
  return { env, scrub, scrubOpenEnded, withheld: command === undefined ? null : secretManipulation(command, secretEnv) };
}

/** What the model reads in place of a withheld output. */
export function withheldOutputNote(reason: string, secretEnv: SecretEnv, exit: string): string {
  const names = [...new Set(Object.values(secretEnv))];
  return `[${exit} — output withheld from the model: ${reason}, so what it printed could carry the value of ${names.join(", ")} in a form the scrub cannot recognise. ` +
    `The user has the output in their inbox. For an API call with this secret use http_request with {{${names[0]}}} (filled on the wire); ` +
    `to use a CLI, hand it the secret and let it read its own environment.]`;
}
