/**
 * Shared credential-file catalog — the ONE structured "is this path a credential
 * file" leaf, by file SHAPE (basename / extension / known cred-dir location).
 *
 * Both the read-taint classifier (data-lineage-paths.ts isSensitivePath) and the
 * file-access read gate (file-access.ts matchesSensitivePath) consume
 * {@link classifySensitivePath} so the gate can be a PROVABLE SUPERSET of the
 * taint classifier and the two can never drift on "what is a credential file."
 * Before this module the gate's regex list silently missed several files the
 * taint classifier flagged (.pgpass, id_ecdsa, .databrickscfg, .keychain-db,
 * age/keys.txt, .my.cnf) — that drift was the bug this catalog closes.
 *
 * A pure leaf module (mirrors security/known-secrets.ts): no app-runtime imports,
 * only string/Set logic. Matches by file shape, NOT by substring — `secrets.json`
 * matches, `mysecrets.json` and `secrets.py` do not.
 *
 * NOTE: the app's OWN at-rest secret basenames (isAppAtRestSecretBasename, from
 * known-secrets.ts) are deliberately NOT folded in here — each caller runs that
 * check separately because it has per-caller scoping (e.g. the file gate scopes
 * it to a `.lax` data-dir segment). This catalog is only the cross-location
 * credential-file shapes.
 */

// Basenames that are credential files regardless of where they live on disk.
// Match is case-insensitive but exact — `secrets.json` matches, `mysecrets.json`
// and `secrets.py` do not.
const SENSITIVE_BASENAMES: ReadonlySet<string> = new Set([
  // Shell / package auth dotfiles.
  ".env", ".envrc", ".npmrc", ".pypirc", ".netrc",
  // SSH private keys (canonical algorithm names).
  "id_rsa", "id_ed25519", "id_ecdsa", "id_dsa",
  // Generic credential / secrets files.
  "auth.json",
  "secrets.json", "secrets.yaml", "secrets.yml", "secrets.toml",
  "credentials.json", "credentials.db",
  // Windows DPAPI-protected master keys (Chromium, etc.).
  "master.dpapi", "master.key",
  // Git stored-credentials (plaintext https creds).
  ".git-credentials",
  // gcloud Application Default Credentials (refresh token / SA key, plaintext).
  "application_default_credentials.json",
  // Postgres / MySQL client password files.
  ".pgpass", ".my.cnf",
  // Databricks CLI config (host + PAT token).
  ".databrickscfg",
  // Unified from the file-access regex list so the gate and the read-taint
  // classifier agree on these single-file credential basenames (were gate-only).
  ".vault-token", ".boto", "terraform.tfstate",
]);

// Suffix matches for key material containers. Endpoint-anchored, so a
// `notes.key.md` file doesn't trip on `.key`.
const SENSITIVE_EXTENSIONS: ReadonlyArray<string> = [
  ".pem", ".key", ".p12", ".pfx", ".keystore", ".keychain-db",
];

// (parent-directory, basename) pairs. The file is sensitive only when its
// immediate parent directory has the named identity — so `~/.aws/credentials`
// trips, but `~/notes/credentials` does not, and a stray `config` file is
// only flagged inside a known config-dir (.ssh, .aws, .kube).
const DIR_SCOPED_FILES: ReadonlyArray<readonly [string, string]> = [
  [".aws", "credentials"],
  [".aws", "config"],
  [".ssh", "config"],
  [".docker", "config.json"],
  [".kube", "config"],
  // gcloud + gh credential stores live under ~/.config/<tool>/...
  ["gcloud", "credentials.db"],
  ["gcloud", "access_tokens.db"],
  ["gh", "hosts.yml"],
  // rclone remote configs hold cloud-storage tokens/keys.
  ["rclone", "rclone.conf"],
  // sops age keys.txt: ~/.config/sops/age/keys.txt — parent dir is `age`.
  ["age", "keys.txt"],
];

// Directories whose entire contents are credential material. Any file at any
// depth inside one of these is flagged — matched mid-path, not just as a
// basename's parent. `.gnupg` is the GPG home. `legacy_credentials` is gcloud's
// per-account OAuth store (~/.config/gcloud/legacy_credentials/<acct>/adc.json):
// the old `["gcloud","legacy_credentials"]` DIR_SCOPED_FILES rule was DEAD — it
// expected `legacy_credentials` as a BASENAME, but the real layout has it as a
// mid-path directory, so every adc.json under it slipped through.
const SENSITIVE_DIR_NAMES: ReadonlySet<string> = new Set([".gnupg", "legacy_credentials"]);

/**
 * Classify a file path as a credential file by SHAPE, using the four structured
 * collections above. Returns true if: the basename is in SENSITIVE_BASENAMES;
 * OR it starts with `.env.` (`.env.local`, `.env.production`, …); OR it ends with
 * a SENSITIVE_EXTENSIONS entry; OR its (parent,basename) is in DIR_SCOPED_FILES;
 * OR any path segment is in SENSITIVE_DIR_NAMES.
 *
 * Does NOT include the app's own at-rest secret basenames — that check is run
 * separately by each caller (see module header).
 */
export function classifySensitivePath(filePath: string): boolean {
  if (!filePath) return false;
  const segs = filePath.split(/[\\/]/).filter(Boolean);
  if (segs.length === 0) return false;
  const segsLower = segs.map(s => s.toLowerCase());
  const base = segsLower[segsLower.length - 1];

  if (SENSITIVE_BASENAMES.has(base)) return true;
  // `.env.local`, `.env.production`, etc. Open-ended, so not in the basename set.
  if (base.startsWith(".env.")) return true;
  for (const ext of SENSITIVE_EXTENSIONS) {
    if (base.endsWith(ext)) return true;
  }

  if (segsLower.length >= 2) {
    const parent = segsLower[segsLower.length - 2];
    for (const [dir, name] of DIR_SCOPED_FILES) {
      if (parent === dir && base === name) return true;
    }
  }

  for (const seg of segsLower) {
    if (SENSITIVE_DIR_NAMES.has(seg)) return true;
  }

  return false;
}
