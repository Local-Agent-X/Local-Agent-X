// ── Transient-error classification ──
//
// Identify provider errors that are worth failing over to another provider
// rather than propagating to the user. These are errors where the *current
// provider* is at fault (rate-limited, out of quota, having an outage) —
// retrying with a different provider should succeed.
//
// NOT included: 400s that are the caller's fault (bad request shape,
// unsupported model parameter) — those won't improve by switching providers.
//
// (The ProviderChain class that used to live here had 0 callers — deleted
// in P3.C3 per AUDIT Critical #5. classifyProviderError is the only live
// export. File kept under its current name to preserve the import path in
// routes/chat.ts; rename to provider-error-classifier.ts is a future tidy.)

export type TransientErrorKind = "rate-limit" | "auth" | "overload" | "network" | "content-filter" | null;

export function classifyProviderError(err: unknown): TransientErrorKind {
  const msg = (err instanceof Error ? err.message : String(err)).toLowerCase();
  if (!msg) return null;

  // Content moderation / safety filter. The request CAN succeed on another
  // provider with different moderation (e.g. Claude), so we treat it as
  // transient for failover purposes even though the current provider won't
  // un-block on retry.
  if (
    msg.includes("content_filter") ||
    msg.includes("content moderation") ||
    msg.includes("content policy") ||
    msg.includes("safety filter") ||
    msg.includes("moderation loop")
  ) return "content-filter";

  // Rate limit / quota
  if (
    msg.includes("rate limit") ||
    msg.includes("rate_limit") ||
    msg.includes("429") ||
    msg.includes("too many requests") ||
    msg.includes("quota") ||
    msg.includes("insufficient_quota")
  ) return "rate-limit";

  // Auth (expired token, revoked key)
  if (
    msg.includes("401") ||
    msg.includes("403") ||
    msg.includes("unauthorized") ||
    msg.includes("invalid api key") ||
    msg.includes("invalid_api_key") ||
    msg.includes("authentication") && msg.includes("fail") ||
    msg.includes("token expired") ||
    msg.includes("expired_token")
  ) return "auth";

  // Provider-side outages / overload
  if (
    msg.includes("overloaded") ||
    msg.includes("service unavailable") ||
    msg.includes("503") ||
    msg.includes("502") ||
    msg.includes("500") ||
    msg.includes("504") ||
    msg.includes("gateway") ||
    msg.includes("internal server error") ||
    msg.includes("bad gateway")
  ) return "overload";

  // Network
  if (
    msg.includes("etimedout") ||
    msg.includes("econnreset") ||
    msg.includes("econnrefused") ||
    msg.includes("enotfound") ||
    msg.includes("socket hang up") ||
    msg.includes("network error") ||
    msg.includes("timeout") ||
    msg.includes("timed out")
  ) return "network";

  return null;
}
