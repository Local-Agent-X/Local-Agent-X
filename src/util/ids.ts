/**
 * Canonical identifier generation. Every op/session/run/correlation id in the
 * codebase routes through here so they are unguessable — `Math.random()` is not
 * cryptographically secure and these ids gate sessions and allowed-path keys.
 *
 * Do NOT hand-roll `Math.random().toString(36)` for ids elsewhere; extend this.
 */
import { randomUUID } from "node:crypto";

/**
 * A short, URL-safe, cryptographically-random id. Optionally prefixed
 * (`randomId("op")` → `op_3f9c1a2b8d4e5f60`). The body is 16 hex chars of
 * CSPRNG entropy (64 bits) — collision-safe for process-local identifiers.
 */
export function randomId(prefix?: string): string {
  const body = randomUUID().replace(/-/g, "").slice(0, 16);
  return prefix ? `${prefix}_${body}` : body;
}

/** A full RFC-4122 v4 UUID, for ids that must interoperate as UUIDs. */
export function uuid(): string {
  return randomUUID();
}
