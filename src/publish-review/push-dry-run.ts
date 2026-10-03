/**
 * Ask git which refs a `git push` would update, without updating them:
 * `git push --dry-run --porcelain` with the agent's own arguments, in the
 * command's directory. This is the only way to get the exact answer — the
 * refspec, push.default, remote.*.push, a `HEAD:refs/heads/x` destination and
 * `--tags`/`--all`/`--mirror` all resolve inside git, and re-implementing that
 * resolution would drift from it.
 *
 * The dry run contacts the remote (to learn its current refs) but runs nothing
 * there: pre-push hooks are skipped (--no-verify) and submodules are not
 * recursed. It signs in with the user's own credential helpers and never the
 * repository's (userCredentialHelpers), since an HTTPS remote answers a push
 * dry run only to a signed-in client; a user with none, pushing to GitHub,
 * is signed in with the token they connected the GitHub integration with
 * (githubTokenFor). Arguments that would make git EXECUTE a
 * program (--receive-pack / --exec) are refused rather than run before the
 * user approved anything, and so is a destination that is not a plain network
 * remote (see push-transport-guard.ts), a push whose own git options or
 * environment the dry run would not reproduce (refusePushInvocation), and a
 * repository whose config would change how that signed-in connection is made.
 */
import { devNull } from "node:os";
import { gitErrorLine, runGit, GIT_REMOTE_TIMEOUT_MS } from "./git-exec.js";
import { isUserScope, readConfig, type ConfigEntry } from "./config-scope.js";
import { isLongOption, pushUrls, refusePushTransport } from "./push-transport-guard.js";
import { githubIntegrationToken, type GithubToken } from "./github-token.js";
import { TOKEN_ENV, TOKEN_HELPER } from "../sync/git-auth.js";
import type { RefUpdate } from "./change-set-types.js";
import type { PublishOperation } from "../publish-operation.js";

// Options the dry run sets itself, or that only change what it prints, by
// their positive names. git keeps the last value given and the agent's
// arguments come after the dry run's own, so every spelling git reads as one
// of these is dropped: an abbreviation (`--veri`), a negation (`--no-dr`
// would make the push real) and a negated negation (`--no-no-verify` is
// `--verify`). -u/--set-upstream changes local config and says nothing about
// which refs move.
const STRIPPED_LONG = ["dry-run", "porcelain", "verify", "recurse-submodules", "quiet", "verbose", "progress", "set-upstream"];
const STRIPPED_SHORT = new Set(["-n", "-q", "-v", "-u"]);
const executesProgram = (a: string): boolean => isLongOption(a, "receive-pack", 4) || isLongOption(a, "exec", 1);

// Repository config the agent can write, overridden for the dry run because
// each entry starts a program on the host (a custom ssh command, an askpass
// program, a hook) or opens the local file transport. No hook can exist under
// the null device, so hooks stay off even if an argument turns verification
// back on. Credential helpers are handled in dryRunArgv.
const TRANSPORT_HARDENING = [
  "-c", "core.sshCommand=ssh", "-c", "core.askPass=", "-c", "protocol.file.allow=never",
  "-c", `core.hooksPath=${devNull}`,
];

// The config that decides how a signed-in connection is made. A credential
// helper is a program, and an empty credential.helper clears every helper git
// has read before it, the repository's (and what it includes) among them, so
// the dry run clears them all and gives back only the user's. Nothing clears
// the rest: an http.* setting for a URL outranks one for every URL, and a
// helper such as Git Credential Manager reads credential.* from the
// repository itself (credential.trace with credential.traceSecrets writes the
// token to a file). So when the repository sets any of it, other than a
// buffer size, a timeout or the HTTP version, the dry run is refused rather
// than hand the user's token to a connection the repository shaped (a proxy,
// TLS checks off, its own CA, a pinned address).
const CONNECTION_CONFIG = "^(credential|http)\\.|^remote\\..+\\.proxy(authmethod)?$";
const INERT_HTTP = new Set(["postbuffer", "lowspeedlimit", "lowspeedtime", "version"]);

// The GitHub integration's token, through sync/git-auth.ts's helper: it
// answers from the child's environment, so the token never enters argv. The
// URL scope has git ask it only for https://github.com, the host the token is
// for, wherever a rewrite or a redirect sends the push. It is lent only when
// the user has no helper of their own, because git hands a credential that
// worked to every helper to store, and theirs would keep the token.
const GITHUB_TOKEN_HELPER = { key: "credential.https://github.com.helper", value: TOKEN_HELPER };
const GITHUB_HTTPS = /^https:\/\/(?:[^/@]*@)?github\.com(?::443)?(?:\/|$)/i;

export type DryRunResult = { ok: true; refs: RefUpdate[] } | { ok: false; reason: string };

/** What the push's command gives git besides its push arguments. */
export type PushInvocation = Pick<PublishOperation, "gitOptions" | "gitEnv">;

// What may stand in front of `push` and leave it the push the dry run runs.
// The dry run runs in the command's directory (the one -C IS that directory)
// with none of the command's other git options or variables, so any other
// option (-c / --config-env url.*.insteadOf, remote.*, core.sshCommand,
// credential.*, core.hooksPath, include.path, push.*; --git-dir, --work-tree,
// --bare, --exec-path, --namespace) or variable (GIT_*, PATH, HOME, a proxy)
// could send the real push elsewhere, send other refs, or start a program the
// review never saw. Refused rather than applied: a short list of the inert
// ones is what can be proved.
const INERT_GIT_OPTIONS = new Set(["--no-pager", "-P", "--no-advice", "--no-optional-locks"]);
const INERT_CONFIG_KEY = /^(?:user\.(?:name|email)|color\..+|advice\..+)$/;
const INERT_ENV = /^(?:LANG|LANGUAGE|LC_[A-Z]+|GIT_TERMINAL_PROMPT)$/;
const NOT_APPLIED = "and the review cannot apply it; not run before approval";

// The subsection is often a URL, and a URL can carry a token.
const shownKey = (key: string): string => key.replace(/^([^.]*)\..*\.([^.]*)$/, "$1.*.$2");

/** Why the push cannot be reviewed as the command will run it, or null. */
export function refusePushInvocation({ gitOptions = [], gitEnv = [] }: PushInvocation): string | null {
  let dirs = 0;
  for (const { name, value } of gitOptions) {
    if (INERT_GIT_OPTIONS.has(name) || (name === "-C" && ++dirs === 1)) continue;
    if (name === "-c" || name === "--config-env") {
      const key = (value ?? "").split("=", 1)[0].toLowerCase();
      if (INERT_CONFIG_KEY.test(key)) continue;
      return `the command sets git config ${shownKey(key)} (${name}) for the push, which can change where it connects, what it sends or what it runs, ${NOT_APPLIED}`;
    }
    return `the command gives git ${name === "-C" ? "-C more than once" : name} before push, which can change the repository, transport or programs the push uses, ${NOT_APPLIED}`;
  }
  const variable = gitEnv.find((n) => !INERT_ENV.test(n));
  return variable === undefined ? null
    : `the command sets ${variable} in the push's environment, which can change where it connects, what it sends or what it runs, ${NOT_APPLIED}`;
}

/** The agent's push arguments minus every one git would read as a stripped option. */
export function passThroughArgs(pushArgs: string[]): string[] {
  return pushArgs.filter((a) => {
    if (STRIPPED_SHORT.has(a)) return false;
    const positive = a.replace(/^--(?:no-)+/, "--");
    return !STRIPPED_LONG.some((full) => isLongOption(positive, full, 1));
  });
}

/** The credential helpers the user's own config gives git in `cwd`, in git's
 *  order, or why the repository's config rules out signing the dry run in. */
export async function userCredentialHelpers(cwd: string): Promise<{ ok: true; helpers: ConfigEntry[] } | { ok: false; reason: string }> {
  const read = await readConfig(cwd, CONNECTION_CONFIG);
  if (!read.ok) return { ok: false, reason: `git could not read the config that decides how the dry run signs in (${read.reason}); not run before approval` };
  const helpers: ConfigEntry[] = [];
  for (const entry of read.entries) {
    const section = entry.key.split(".", 1)[0];
    const variable = entry.key.slice(entry.key.lastIndexOf(".") + 1);
    if (section === "credential" && variable === "helper") {
      if (isUserScope(entry.scope)) helpers.push(entry);
    } else if (!isUserScope(entry.scope) && !(section === "http" && INERT_HTTP.has(variable))) {
      return { ok: false, reason: `the repository's git config (${entry.scope}) sets ${shownKey(entry.key)}, which changes how the dry run would connect or sign in with your saved credentials; not run before approval` };
    }
  }
  return { ok: true, helpers };
}

/** The GitHub integration's token, when the dry run of a push of already
 *  filtered arguments signs in with it: the user's config gives no credential
 *  helper (`helpers` holds at most resets) and the push can go to github.com
 *  over HTTPS. */
export async function githubTokenFor(cwd: string, passed: string[], helpers: ConfigEntry[]): Promise<GithubToken | null> {
  if (helpers.some((h) => h.value !== "")) return null;
  const token = githubIntegrationToken();
  if (!token) return null;
  return (await pushUrls(cwd, passed)).some((u) => GITHUB_HTTPS.test(u)) ? token : null;
}

/** The git argv that dry-runs a push of already filtered arguments, signed in
 *  with exactly `helpers`: the user's own, and the GitHub integration's. */
export function dryRunArgv(passed: string[], helpers: Array<Pick<ConfigEntry, "key" | "value">>): string[] {
  const given = helpers.flatMap(({ key, value }) => ["-c", value === null ? key : `${key}=${value}`]);
  return [
    ...TRANSPORT_HARDENING, "-c", "credential.helper=", ...given,
    "push", "--dry-run", "--porcelain", "--no-verify", "--recurse-submodules=no", ...passed,
  ];
}

export async function pushDryRun(cwd: string, pushArgs: string[], invocation: PushInvocation): Promise<DryRunResult> {
  const invoked = refusePushInvocation(invocation);
  if (invoked) return { ok: false, reason: invoked };
  if (pushArgs.some(executesProgram)) {
    return { ok: false, reason: "the push names a custom --receive-pack/--exec program, which a dry run would execute; not run before approval" };
  }
  const passed = passThroughArgs(pushArgs);
  const refused = await refusePushTransport(cwd, passed);
  if (refused) return { ok: false, reason: refused };
  const credentials = await userCredentialHelpers(cwd);
  if (!credentials.ok) return credentials;
  const token = await githubTokenFor(cwd, passed, credentials.helpers);
  const helpers = token ? [...credentials.helpers, GITHUB_TOKEN_HELPER] : credentials.helpers;
  const r = await runGit(cwd, dryRunArgv(passed, helpers), {
    timeoutMs: GIT_REMOTE_TIMEOUT_MS,
    ...(token ? { env: { [TOKEN_ENV]: token.value } } : {}),
  });
  const refs = parsePorcelain(r.stdout);
  // A push with a rejected ref exits non-zero but still reports every ref.
  if (refs.length === 0 && (r.code !== 0 || r.missing || r.timedOut)) {
    return { ok: false, reason: `git push --dry-run failed: ${gitErrorLine(r)}` };
  }
  return { ok: true, refs };
}

/**
 * Parse `git push --porcelain` output:
 *   To <url>
 *   <flag>\t<from>:<to>\t<summary> (<reason>)
 *   Done
 * flag: ' ' fast-forward, '+' forced, '-' deleted, '*' new, '!' rejected,
 * '=' up to date. The summary carries abbreviated shas for updates
 * (`old..new`, `old...new`); callers resolve them to full shas.
 */
export function parsePorcelain(stdout: string): RefUpdate[] {
  const refs: RefUpdate[] = [];
  for (const line of stdout.split(/\r?\n/)) {
    const m = /^([ +\-*!=])\t([^\t]*)\t(.*)$/.exec(line);
    if (!m) continue;
    const [, flag, spec, summary] = m;
    const colon = spec.lastIndexOf(":");
    const localRef = colon >= 0 ? spec.slice(0, colon) : "";
    const remoteRef = colon >= 0 ? spec.slice(colon + 1) : spec;
    const range = /^([0-9a-f]{4,64})\.\.\.?([0-9a-f]{4,64})/.exec(summary);
    const note = /\(([^)]*)\)\s*$/.exec(summary)?.[1];
    const status: RefUpdate["status"] =
      flag === "*" ? "new" : flag === "+" ? "forced" : flag === "-" ? "deleted"
        : flag === "!" ? "rejected" : flag === "=" ? "up-to-date" : "fast-forward";
    refs.push({
      remoteRef,
      localRef,
      status,
      ...(range ? { oldSha: range[1], newSha: range[2] } : {}),
      ...(status === "rejected" && note ? { note } : {}),
    });
  }
  return refs;
}
