/**
 * Classification of the app's OWN special files under a `.lax` data dir.
 *
 * Two kinds live here because they answer the same question — "is this path one
 * of Local Agent X's own files, as opposed to the user's content?" — and both
 * are consumed by the same gate in file-access.ts:
 *
 *   isAppAtRestSecretUnderLax — at-rest key/seed material. Blocked for READ
 *                               and write; it is credential material.
 *   isLaxControlFile          — capability-control files. READABLE, but never
 *                               writable; they define what the agent may do.
 *
 * ── The app's OWN capability-control files ──
 *
 * NOT secrets, and deliberately still READABLE: knowing your own configuration
 * is benign, and the agent legitimately reads settings to resolve its provider,
 * model, and workspace. WRITING them is privilege escalation, because these
 * files ARE the user's leash:
 *
 *   settings.json    — the 13 `protected: true` security settings
 *                      (developer_mode, toolApproval, enableShell, localOnlyMode…)
 *   config.json      — the runtime mirror of those same settings
 *   tool-policy.json — the tool capability rule table
 *   security.json    — egressMode + the egress allowlist + localServicePorts +
 *                      inlineEvalPolicy. Every field here is a leash: flipping
 *                      egressMode to "permissive" opens outbound to any host,
 *                      adding a localServicePorts entry opens a loopback port,
 *                      and inlineEvalPolicy:"allow" switches OFF the inline-eval
 *                      interpreter-escape refusal. Added 2026-07-29 — it was the
 *                      one file of this kind missing from the set, and its
 *                      absence was load-bearing in the wrong direction: the
 *                      argument that a forged ~/.lax/dev-servers record grants
 *                      no new authority rests on security.json being writable,
 *                      i.e. on this very gap. Nothing in src/ writes it (every
 *                      reference is a readFileSync), so blocking writes costs
 *                      no legitimate path; users edit it by hand.
 *
 * Every INTENDED mutation path is gated: the `setting` tool requires explicit
 * user approval (tool-execution/protected-setting-gate.ts), POST /api/settings
 * requires a real operator token (routes/settings/preferences.ts), and the agent
 * RBAC role is denied /api/security and /api/tool-policy (rbac.ts). A raw file
 * write walks past all three at once, which is what makes this block
 * load-bearing rather than redundant with them.
 *
 * Enforced in file-access.ts ABOVE the mode branches, so "unrestricted" file
 * access does not mean "may rewrite my own permissions".
 */

import { isAppAtRestSecretBasename } from "../secrets/known-secrets.js";

/** True when every path segment before the basename contains a `.lax` dir. */
function underLaxDir(segs: string[]): boolean {
  for (let i = 0; i < segs.length - 1; i++) {
    if (segs[i]?.toLowerCase() === ".lax") return true;
  }
  return false;
}

/**
 * The app's OWN at-rest secret/key/seed files under a `.lax` data dir.
 *
 * Derived from the ONE canonical enumeration (security/known-secrets.ts) so this
 * read gate / write block can never drift from the read-taint classifier or the
 * attachment denylist. Scoped to a `.lax` dir segment so a user file that happens
 * to be named e.g. `auth.json` outside the data dir isn't caught by THIS rule
 * (auth.json/master.* still match the cross-location SENSITIVE_PATTERNS in
 * file-access.ts where they already did) — the coverage this adds is
 * `audit-key` / `audit-key.enc` / `secrets.salt` under the app's data dir.
 */
export function isAppAtRestSecretUnderLax(p: string): boolean {
  const segs = p.split(/[\\/]/).filter(Boolean);
  if (segs.length < 2) return false;
  const base = segs[segs.length - 1];
  if (base === undefined || !isAppAtRestSecretBasename(base)) return false;
  return underLaxDir(segs);
}

const LAX_CONTROL_FILE_BASENAMES = new Set([
  "settings.json", "config.json", "tool-policy.json", "security.json",
]);

/**
 * True when `p` is one of the app's capability-control files inside a `.lax`
 * data dir. Scoped to a `.lax` path segment so a user's own project
 * `config.json` or `settings.json` is untouched — this rule is about OUR data
 * dir only, matching how isAppAtRestSecretUnderLax scopes itself.
 */
export function isLaxControlFile(p: string): boolean {
  const segs = p.split(/[\\/]/).filter(Boolean);
  if (segs.length < 2) return false;
  const base = segs[segs.length - 1];
  if (base === undefined || !LAX_CONTROL_FILE_BASENAMES.has(base.toLowerCase())) return false;
  return underLaxDir(segs);
}

/** The basenames this module guards. Exported for the cross-seam contract test. */
export function laxControlFileBasenames(): string[] {
  return [...LAX_CONTROL_FILE_BASENAMES];
}
