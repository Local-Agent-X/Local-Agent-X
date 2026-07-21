# Provider authentication storage

Local Agent X has two credential-storage boundaries: files owned by LAX and
stores owned by external CLI tools. A `.json` filename does not by itself say
whether the contents are plaintext.

## LAX-owned encrypted stores

LAX writes these provider credentials as AES-256-GCM `lax-auth-v2` envelopes:

| Path | Contents |
| --- | --- |
| `~/.lax/auth.json` | OpenAI OAuth tokens used by LAX |
| `~/.lax/anthropic-auth.json` | Anthropic setup-token (`method:"token"`) or LAX-owned OAuth tokens (`method:"oauth"`) — written by the paste-code flow for the direct-thinking path and refreshed by LAX; includes legacy OAuth tokens |
| `~/.lax/xai-auth.json` | xAI OAuth tokens used by LAX |

The filenames are retained for compatibility, but the files contain envelope
metadata (`format`, `iv`, `ciphertext`, and authentication `tag`), not readable
token fields. Each current envelope is authenticated against its provider
namespace and absolute path. Provider API keys are stored separately in the
encrypted `~/.lax/secrets.enc` vault and are not written to `settings.json`.

The same 32-byte master key protects the secrets vault and provider envelopes.
On Windows it is protected with DPAPI for the current user; on macOS it is in
the user's Keychain; on Linux LAX uses libsecret when available. The OS
keychain protects the master key, not each provider token as an individual
keychain item.

When no supported OS keychain is available, LAX still encrypts the files but
uses a weaker file fallback: scrypt derives the master key from the machine
hostname, local username, and `~/.lax/secrets.salt`. `LAX_DISABLE_OS_KEYCHAIN=1`
selects that fallback explicitly. It should not be enabled for an existing
keychain-backed install because changing the master-key source can make the
existing encrypted files unreadable.

## External CLI-native stores

These stores use formats controlled by their CLI, outside LAX's encrypted
envelope implementation:

| Path | Owner and behavior |
| --- | --- |
| `~/.claude/.credentials.json` | Claude CLI login. The Settings paste-code flow writes the CLI format. |
| `~/.codex/auth.json` | Codex CLI login or an optional LAX bridge. LAX does not encrypt this CLI format. |
| `~/.grok/auth.json` | Grok Build CLI login. LAX does not encrypt this CLI format. |

The default Codex app-build bridge first checks for `~/.codex/auth.json`. If the
CLI-native file already exists, LAX uses it unchanged and does not load or
mirror LAX OAuth tokens into that path. If no file exists and a build needs one,
LAX creates a temporary plaintext CLI mirror and removes it after the subprocess
finishes. `LAX_MIRROR_CODEX_AUTH=1` is the explicit opt-in that lets LAX own and
persistently replace the plaintext CLI mirror; `LAX_MIRROR_CODEX_AUTH=0`
disables both the persistent and just-in-time bridge. A separate `codex login`
remains owned by the CLI. File permissions and full-disk encryption are the
at-rest protections for CLI-native files unless the CLI itself provides
stronger storage.

## Failure and recovery

Provider-auth writes fail closed. If LAX cannot obtain a valid master key or
encrypt a credential, the normal login/setup-token routes refuse the write;
they do not silently write plaintext. Reads that cannot authenticate, decrypt,
or validate an envelope are reported as not signed in, with an error in the
server log. Restore access to the original OS keychain/master key and restart.
If the credential itself is unrecoverable, intentionally remove the affected
credential envelope and sign in again.

LAX does not automatically replace a missing or unreadable master key while
encrypted dependents remain, because doing so would permanently orphan them.
Restoring only the encrypted files on a new OS account or machine is therefore
not a complete credential backup; the matching keychain/master-key material is
also required. Moving a current path-bound provider envelope can likewise make
it unreadable.

On a successful read, legacy plaintext provider files and older `lax-auth-v1`
or basename-bound envelopes are validated and rewritten in place as current
path-bound `lax-auth-v2` envelopes. If that migration rewrite cannot be
encrypted, the provider is treated as signed out instead of continuing with a
plaintext store. Re-login creates a fresh current envelope; it is not normally
required when automatic migration succeeds.

The storage module contains an explicit `allowUnencryptedWrite` degraded-mode
option that emits a warning, but no production route, setting, or environment
variable passes it. Degraded plaintext provider storage is therefore not
reachable in the shipped runtime.
