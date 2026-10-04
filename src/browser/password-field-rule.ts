/**
 * The agent never types into a password field. Whatever it types passes
 * through the model provider, so a password it typed would be one the user
 * had pasted into the chat. A password reaches a page only from the vault
 * (browser_fill_from_secret, secret-fill.ts: server-side, the value never in
 * the model's context, bound to the site it was saved for) or from the user's
 * own hands. Every fill path on both backends refuses here; the vault fill
 * takes its own path (secret-ops.ts) and is unaffected.
 *
 * This replaced a login-wall detector that guessed from page text and fired
 * on logged-in pages showing a masked API token (2026-10-03): the rule needs
 * no guess about what the page is.
 */

export const PASSWORD_FIELD_REFUSAL =
  "This is a password field, and passwords never go through you. If the vault has this site's password " +
  "(list_secrets shows each secret's site), fill it with browser_fill_from_secret. Otherwise tell the user this " +
  "page needs their login: they type it themselves, or save it with request_secret (url = this login page) so " +
  "you can fill it from the vault next time. Continue with any other part of the request meanwhile.";

/** Thrown where a fill meets a password field, so a fallback chain stops
 *  rather than trying the next way to write the same field. */
export class PasswordFieldRefused extends Error {
  constructor() {
    super(PASSWORD_FIELD_REFUSAL);
    this.name = "PasswordFieldRefused";
  }
}

/** Whether an element's `type` (as a snapshot or a hit test reports it) makes it a password field. */
export function isPasswordFieldType(type: string | null | undefined): boolean {
  return (type ?? "").toLowerCase() === "password";
}
