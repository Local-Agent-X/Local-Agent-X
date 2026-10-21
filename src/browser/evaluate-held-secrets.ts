/**
 * What a page HOLDS must not reach the model through an evaluate result.
 *
 * The script blocklist (guards.ts, section 1) refuses the spellings of a
 * cookie / storage / password read it can recognise, and a regex over source
 * text can always be spelled around: `document["coo" + k]`, a prototype
 * getter, a `type^="pass"` selector. The guarantee therefore lives on the
 * RESULT side, where spelling plays no part: before the agent's script runs,
 * the host reads the values the page holds (secret-ops.ts heldSecretsScript —
 * cookies, web storage, password fields), and whatever the script returns is
 * masked wherever one of those values appears, raw, encoded or normalized,
 * through the same known-value pass the egress scan uses. Reading happens
 * BEFORE the script so a script that reads a cookie and then expires it is
 * still caught.
 *
 * What counts, so an ordinary page's values are not masked out of ordinary
 * results: a cookie that is long and secret-shaped (a `theme=light` is not);
 * a storage entry whose key names a credential or whose value has a known
 * credential format (a cached product list is not); a password field's value
 * whenever it is secret-shaped. Nothing is registered: the values are the
 * page's, not the user's, and registering them would refuse the page's own
 * traffic at every egress sink.
 *
 * Conceded: a value with no credential name or format in storage, a numeric
 * PIN in a password field, and a frame's own cookies and fields (the read is
 * over the top document, like visibleValues).
 */
import { maskHeldValues } from "../data-lineage/secret-values.js";
import { isEmailAddress, isSecretShaped, namesCredential, scanForSecrets } from "../security/secrets/index.js";
import type { HeldSecret, SecretBrowserOps } from "./secret-ops.js";

/** The masker's name for a hit, and the note the model reads. */
export const HELD_SECRET_KIND = "Page-held Secret";

// A cookie's value is an opaque identifier by nature; the catalog's bar for a
// key-value credential (credential-patterns.ts) keeps `lang=en-US` out.
const MIN_HELD_COOKIE = 12;

function hasCredentialFormat(value: string): boolean {
  return scanForSecrets(value).matches.some((m) => m.type !== "high-entropy-token" && !m.marker);
}

function counts(h: HeldSecret): boolean {
  if (!isSecretShaped(h.value) || isEmailAddress(h.value)) return false;
  if (h.kind === "cookie") return h.value.length >= MIN_HELD_COOKIE;
  if (h.kind === "storage") return namesCredential(h.name) || hasCredentialFormat(h.value);
  return true;
}

/** The values to mask out of this result, read from the page now. */
export async function heldSecretValues(ops: SecretBrowserOps): Promise<string[]> {
  return [...new Set((await ops.heldSecrets()).filter(counts).map((h) => h.value))];
}

/** `output` with every held value masked, and a note when any was. */
export function maskHeldSecrets(output: string, held: readonly string[]): string {
  const { text, masked } = maskHeldValues(output, held, HELD_SECRET_KIND);
  if (masked === 0) return output;
  return (
    `${text}\n\n[${masked} value${masked === 1 ? "" : "s"} the page holds as a credential (a cookie, a storage entry, a password field) masked: ` +
    `evaluate cannot read page secrets into the model context. If you need the page's login state, ask the user.]`
  );
}
