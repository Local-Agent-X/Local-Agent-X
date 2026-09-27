/**
 * A secret the user can SEE on the page — a token a service shows once, an API
 * key in a field — must not reach the model through a screenshot, and need not:
 * browser_capture_to_secret reads it host-side straight into the vault.
 *
 * Live 2026-09-26: Supabase showed a new full-access token in its "Token
 * created" dialog; the agent took a screenshot "to check the page", which sent
 * the token to the model provider, then clicked Done without saving it, and the
 * token had to be thrown away. Earlier the same evening the same agent captured
 * the first token correctly — the capture path works; nothing stopped the
 * screenshot.
 *
 * A known credential shape counts anywhere it is visible. A random
 * high-entropy string counts only in a form field: code blocks full of commit
 * hashes would otherwise block every screenshot of a repository.
 */
import { scanForSecrets } from "../security/secrets/secret-scanner.js";
import type { SecretBrowserOps } from "./secret-ops.js";

export interface SecretOnScreen {
  /** The scanner's name for it ("Supabase Token") — never the value. */
  kind: string;
  selector: string;
  field: boolean;
}

export async function findSecretOnScreen(ops: SecretBrowserOps): Promise<SecretOnScreen | null> {
  for (const v of await ops.visibleValues()) {
    const match = scanForSecrets(v.value).matches.find((m) => m.type !== "high-entropy-token" || v.field);
    if (match) return { kind: match.pattern, selector: v.selector, field: v.field };
  }
  return null;
}

/** What the model is told instead of getting the screenshot: the capture call
 *  that saves the value without reading it, the dialog it must not close, and
 *  the user's secrets card as the fallback. */
export function secretOnScreenMessage(s: SecretOnScreen): string {
  const target = s.field ? `selector: ${JSON.stringify(s.selector)}` : `text_selector: ${JSON.stringify(s.selector)}`;
  return (
    `BLOCKED: this page is showing a secret (${s.kind}). A screenshot would send it to the model provider, so none was taken. ` +
    `Save it without reading it: browser_capture_to_secret({ name: "<SERVICE_PURPOSE_TOKEN>", service: "<service>", ${target} }). ` +
    `Leave the page exactly as it is until that succeeds — do not click Done, "I've copied it", or close the dialog; many services show a new token only once. ` +
    `If the capture fails, call request_secrets so the user can copy it into the secrets card, and wait for them before going on.`
  );
}
