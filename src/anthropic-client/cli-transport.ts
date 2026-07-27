/**
 * The one gate for the legacy `claude` CLI subprocess transport.
 *
 * The CLI is no longer a supported way to connect. Subscription credentials
 * now reach Anthropic over direct HTTP wearing Claude Code's identity (see
 * oauth-direct.ts) — same token, same plan billing, no subprocess. The CLI
 * code is deliberately KEPT, not deleted: it is the only fallback if Anthropic
 * ever tightens the direct-HTTP path, and re-enabling it is a one-env-var
 * change rather than a revert.
 *
 * Why a gate instead of deleting the call sites: routing used to be decided
 * from credential SHAPE (`token === "cli"`, an `oauth:` prefix, an `sk-ant-oat`
 * substring) and never checked whether the binary existed. On a box without
 * `claude` on PATH that produced a spawn that died instantly and a turn that
 * hung forever — wedging the cap-1 background lane and stalling every queued
 * dream behind it (2026-07-26). Availability, not credential shape, decides.
 *
 * Everything that used to spawn `claude` must ask HERE first.
 */

/** Env escape hatch. Unset/anything-but-"1" keeps the CLI transport hidden. */
const CLI_TRANSPORT_ENV = "LAX_ANTHROPIC_CLI_TRANSPORT";

/**
 * True only when the operator has explicitly re-enabled the hidden CLI
 * subprocess transport. Read at call time (not module load) so a test or a
 * restart-free toggle takes effect immediately.
 */
export function isAnthropicCliTransportEnabled(): boolean {
  return process.env[CLI_TRANSPORT_ENV] === "1";
}

/** Human-readable reason surfaced when a caller asks for a path that is hidden. */
export const CLI_TRANSPORT_HIDDEN_REASON =
  "The Claude CLI transport is disabled. Anthropic subscription auth now uses the "
  + "direct HTTPS path — sign in again under Settings → Account → Anthropic if this persists.";
