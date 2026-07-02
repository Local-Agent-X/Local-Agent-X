// ── Missing-credentials recovery (the "no Supabase keys" class) ──
//
// A third-party credential that isn't configured must never end a build: the
// worker can always ship placeholder envs, keep the app building/booting
// without the live service, and defer real-credential verification to
// LAUNCH_READINESS (live failure 2026-07-02: chunk 2 halted on "Build fails
// solely on missing Supabase credentials" and the user had to type the
// recovery instruction by hand). Detection = a credential term AND a missing
// term in the worker's own words. A false positive costs one bounded retry
// carrying the instruction (push_back is retry-once), never a wrong commit.

// The last alternative catches literal env-var NAMES (SUPABASE_ANON_KEY,
// STRIPE_SECRET_KEY, DATABASE_URL) — \b can't split SCREAMING_SNAKE tokens, so
// the word-form alternatives never match inside them.
export const CRED_TERM =
  /\b(credential|api[\s_-]?key|anon[\s_-]?key|service[\s_-]?(role|key)|client[\s_-]?secret|access[\s_-]?token|auth[\s_-]?token|\.env|env(ironment)?\s+var(iable)?s?|connection\s+string|dsn|(supabase|stripe|firebase|twilio|openai|aws|oauth)\s+(url|key|keys|creds?|credentials|config)|\w+_(key|token|secret|url|dsn|password)s?)\b/i;

const MISSING_TERM =
  /\b(missing|not\s+(set|configured|provided|present|available|found)|no\s+(real|valid)|absent|unset|need(s|ed)?|require[sd]?|lack(s|ing)?|without)\b/i;

export function mentionsMissingCreds(text: string): boolean {
  return CRED_TERM.test(text) && MISSING_TERM.test(text);
}

export const MISSING_CREDS_RECOVERY =
  "Missing third-party credentials are NEVER a blocker — do not report blocked/partial for this. " +
  "Recover in this order: (1) add clearly-fake placeholder values for every missing variable to the " +
  "framework's local env file (e.g. .env.local: NEXT_PUBLIC_SUPABASE_URL=https://placeholder.supabase.co, " +
  "NEXT_PUBLIC_SUPABASE_ANON_KEY=fake-anon-key-local-dev); (2) make client construction tolerate " +
  "placeholders — the build and dev boot must succeed without the real service (guard or lazy-init, " +
  "never throw at import time); (3) list each real-credential setup + verification step in " +
  "LAUNCH_READINESS, naming the exact env vars; (4) report DONE_WHEN: deferred-to-launch-readiness if " +
  "the done-when needs the live service, met otherwise. Everything that does not need the live service " +
  "must still be fully implemented and verified.";
