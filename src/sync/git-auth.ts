// Supply the vault's GITHUB_SYNC_TOKEN to git WITHOUT persisting it. The remote
// stays a bare URL (no secret in .git/config), and the token is passed to each
// git child through the ENV — read by an inline credential helper. That keeps it
// off disk AND out of argv (visible in any process listing), unlike the old
// approach of baking it into the remote URL.
import { devNull } from "node:os";

/** The variable a git child reads its token from; the pre-publish push dry
 *  run hands the GitHub integration's token over the same way. */
export const TOKEN_ENV = "GIT_SYNC_TOKEN";

// `!f() {...}; f` is git's inline-shell credential helper form; git runs it via
// its bundled sh on every platform, so reading $GIT_SYNC_TOKEN works on
// Windows/macOS/Linux alike. Note this string carries the env-var NAME, not the
// token value.
export const TOKEN_HELPER = `!f() { echo username=x-access-token; echo "password=$${TOKEN_ENV}"; }; f`;

/** Overrides on every sync git child. Sync needs no hook, no fsmonitor daemon
 *  and no ext:: transport, and each of them runs a program that config written
 *  by anything else on the machine could name. No hook can exist under the
 *  null device. */
export const SYNC_GIT_HARDENING = [
  "-c", `core.hooksPath=${devNull}`, "-c", "core.fsmonitor=false", "-c", "protocol.ext.allow=never",
];

/** `scheme://host[:port]` of an http(s) repository URL: the only URL the
 *  token is offered to. */
function credentialScope(repoUrl: string): string | null {
  try {
    const u = new URL(repoUrl);
    return u.protocol === "https:" || u.protocol === "http:" ? `${u.protocol}//${u.host}` : null;
  } catch {
    return null;
  }
}

/**
 * git `-c` args for an invocation. The empty `credential.helper=` first RESETS
 * the host helper chain (Windows GCM / macOS osxkeychain) so only the vault can
 * authorize; with a token, a second `-c` appends our env-reading helper, scoped
 * to the configured repository's host, so a push or fetch that a rewrite rule or
 * a redirect sends anywhere else is never handed the token.
 */
export function gitCredentialArgs(token: string | undefined, repoUrl: string): string[] {
  const scope = credentialScope(repoUrl);
  return token && scope
    ? ["-c", "credential.helper=", "-c", `credential.${scope}.helper=${TOKEN_HELPER}`]
    : ["-c", "credential.helper="];
}

/** Env additions for an authenticated git child — merge over process.env.
 *
 * The author/committer identity rides along for the same self-containment
 * reason as the credential helper: sync's git must never depend on host git
 * config. Live failure (2026-07-23): a machine with no global user.email made
 * every sync commit die with "Author identity unknown", wedging sync — on
 * that box only. All four vars are needed; git requires author AND committer.
 */
export function gitCredentialEnv(token: string | undefined): Record<string, string> {
  return {
    GIT_TERMINAL_PROMPT: "0", GIT_ASKPASS: "", [TOKEN_ENV]: token ?? "",
    GIT_AUTHOR_NAME: "Local Agent X Sync", GIT_AUTHOR_EMAIL: "sync@localagentx.invalid",
    GIT_COMMITTER_NAME: "Local Agent X Sync", GIT_COMMITTER_EMAIL: "sync@localagentx.invalid",
  };
}
