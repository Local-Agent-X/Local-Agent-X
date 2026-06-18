// Supply the vault's GITHUB_SYNC_TOKEN to git WITHOUT persisting it. The remote
// stays a bare URL (no secret in .git/config), and the token is passed to each
// git child through the ENV — read by an inline credential helper. That keeps it
// off disk AND out of argv (visible in any process listing), unlike the old
// approach of baking it into the remote URL.

// `!f() {...}; f` is git's inline-shell credential helper form; git runs it via
// its bundled sh on every platform, so reading $GIT_SYNC_TOKEN works on
// Windows/macOS/Linux alike. Note this string carries the env-var NAME, not the
// token value.
const INLINE_HELPER = `!f() { echo username=x-access-token; echo "password=$GIT_SYNC_TOKEN"; }; f`;

/**
 * git `-c` args for an invocation. The empty `credential.helper=` first RESETS
 * the host helper chain (Windows GCM / macOS osxkeychain) so only the vault can
 * authorize; with a token, a second `-c` appends our env-reading helper.
 */
export function gitCredentialArgs(token: string | undefined): string[] {
  return token
    ? ["-c", "credential.helper=", "-c", `credential.helper=${INLINE_HELPER}`]
    : ["-c", "credential.helper="];
}

/** Env additions for an authenticated git child — merge over process.env. */
export function gitCredentialEnv(token: string | undefined): Record<string, string> {
  return { GIT_TERMINAL_PROMPT: "0", GIT_ASKPASS: "", GIT_SYNC_TOKEN: token ?? "" };
}
