// What an integration install carries: the values the user supplied, paired
// with the credentials the integration declared, and the API host the key is
// for. Split from integrations.ts, the route file, at the source-hygiene
// ceiling; the route still owns what is written where.
import { isRequiredRequirement, type CredentialRequirement } from "../../credentials/requirements.js";

export type InstallBody = { id: string; secretValue?: unknown; secretValues?: unknown };

/** The host an HTTP integration's calls reach; null when it has none (email). */
export function apiHostOf(baseUrl: string): string | null {
  try { return baseUrl ? new URL(baseUrl).hostname || null : null; } catch { return null; }
}

/**
 * Pairs each supplied install value with the credential it was DECLARED under.
 * `secretValues` is the multi-credential shape; a bare `secretValue` still means
 * "the primary credential", so every caller written against the single-field
 * install keeps working unchanged.
 *
 * A name the integration does not declare is rejected outright, and resolution
 * completes before anything is written, so a rejected install never leaves a
 * partial write behind. That check bounds a write to the DECLARED names only —
 * it is not a proof that this route cannot write an arbitrary secret, because
 * the declaration itself is authored over the network (POST /api/integrations
 * accepts any credential list). It is the same capability, at the same
 * privilege, that POST /api/secrets already exposes.
 *
 * There is no silent-success branch here. Every arm that cannot produce a
 * stored credential returns an error, so the route never answers 200 over a
 * vault it wrote nothing to:
 *   - a supplied value that is not a string, or is the empty string, is an
 *     error rather than a skip (the modal already refuses to submit a blank, so
 *     nothing legitimate sends one);
 *   - the PRIMARY credential must end up supplied whenever the integration
 *     declares any, because the primary is what the single-name readers
 *     (uninstall, /api/integrations/test, the tool auth path) act on — that is a
 *     property of this seam, so a declaration cannot opt out of it;
 *   - every OTHER credential must be supplied unless the declaration says the
 *     integration runs without it (`required: false`). Answering 200 over a
 *     declaration whose own terms are unmet is the same silent success the rules
 *     above remove: it marks the integration CONNECTED on a configuration that
 *     cannot work. The Settings modal enforces the identical rule client-side
 *     (it blocks submit on a blank REQUIRED field and skips a blank optional
 *     one), so the two ends of the install cannot drift;
 *   - an integration that declares NO credentials has nothing to store, so it
 *     installs cleanly on an empty body — but supplying a value for it is an
 *     error, because there is no declared name to bind that value to.
 */
export function resolveInstallValues(
  credentials: CredentialRequirement[],
  body: InstallBody,
): { values: Array<{ requirement: CredentialRequirement; value: string }> } | { error: string } {
  const declared = new Map(credentials.map(c => [c.name, c]));
  const supplied = new Map<string, string>();
  if (body.secretValues !== undefined) {
    const raw = body.secretValues;
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { error: "secretValues must be an object" };
    for (const [name, value] of Object.entries(raw as Record<string, unknown>)) {
      if (!declared.has(name)) return { error: `Integration does not declare credential ${name}` };
      if (typeof value !== "string") return { error: `Credential ${name} must be a string` };
      if (!value) return { error: `Credential ${name} must not be empty` };
      supplied.set(name, value);
    }
  }
  if (body.secretValue !== undefined) {
    const primary = credentials[0];
    if (!primary) return { error: "Integration declares no credentials" };
    if (typeof body.secretValue !== "string") return { error: `Credential ${primary.name} must be a string` };
    if (!body.secretValue) return { error: `Credential ${primary.name} must not be empty` };
    if (!supplied.has(primary.name)) supplied.set(primary.name, body.secretValue);
  }
  const primary = credentials[0];
  if (primary && !supplied.has(primary.name)) return { error: `Credential ${primary.name} is required` };
  const missing = credentials.find(c => isRequiredRequirement(c) && !supplied.has(c.name));
  if (missing) return { error: `Credential ${missing.name} is required` };
  return { values: [...supplied].map(([name, value]) => ({ requirement: declared.get(name)!, value })) };
}
