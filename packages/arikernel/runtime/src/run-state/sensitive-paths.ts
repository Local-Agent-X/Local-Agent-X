/**
 * Sensitive file path detection — by file SHAPE (basename, extension, or a
 * known credential directory), never by substring.
 *
 * The former matcher tested /secret|token|password|credentials|\.env/ against
 * the whole path, so every file NAMED for its subject counted as a credential:
 * `scripts/set-unsub-secret.mjs`, `tokenStore.ts`, `passwordReset.ts`. A write
 * of the first, followed by a POST the agent had authored, quarantined a whole
 * run under rule 3; a read of it made the next GET's Authorization header a
 * "custom header after a sensitive read". A name is not a credential. A
 * credential file has a shape, and this catalog names the shapes.
 */

import { normalizeInput } from "../unicode-safety.js";

// Credential files by exact (case-insensitive) basename, wherever they live.
const SENSITIVE_BASENAMES: ReadonlySet<string> = new Set([
	".env",
	".envrc",
	".npmrc",
	".pypirc",
	".netrc",
	"id_rsa",
	"id_ed25519",
	"id_ecdsa",
	"id_dsa",
	"auth.json",
	"secrets.json",
	"secrets.yaml",
	"secrets.yml",
	"secrets.toml",
	"credentials.json",
	"credentials.db",
	"master.key",
	"master.dpapi",
	".git-credentials",
	"application_default_credentials.json",
	".pgpass",
	".my.cnf",
	".databrickscfg",
	".vault-token",
	".boto",
	"terraform.tfstate",
]);

// Key-material containers, matched on the basename's end.
const SENSITIVE_EXTENSIONS: ReadonlyArray<string> = [
	".pem",
	".key",
	".p12",
	".pfx",
	".keystore",
	".keychain-db",
];

// (parent directory, basename): `~/.aws/credentials` is one, `~/notes/credentials` is not.
const DIR_SCOPED_FILES: ReadonlyArray<readonly [string, string]> = [
	[".aws", "credentials"],
	[".aws", "config"],
	[".ssh", "config"],
	[".docker", "config.json"],
	[".kube", "config"],
	["gcloud", "credentials.db"],
	["gcloud", "access_tokens.db"],
	["gh", "hosts.yml"],
	["rclone", "rclone.conf"],
	["age", "keys.txt"],
];

// Directories whose whole contents are credential material, at any depth.
const SENSITIVE_DIR_NAMES: ReadonlySet<string> = new Set([".gnupg", "legacy_credentials"]);

/** Check if a file path targets a sensitive location. NFKC-normalized to prevent homoglyph bypass. */
export function isSensitivePath(path: string): boolean {
	const segs = normalizeInput(path)
		.split(/[\\/]/)
		.filter(Boolean)
		.map((s) => s.toLowerCase());
	if (segs.length === 0) return false;
	const base = segs[segs.length - 1];

	if (SENSITIVE_BASENAMES.has(base)) return true;
	if (base.startsWith(".env.")) return true;
	if (SENSITIVE_EXTENSIONS.some((ext) => base.endsWith(ext))) return true;
	if (segs.length >= 2) {
		const parent = segs[segs.length - 2];
		if (DIR_SCOPED_FILES.some(([dir, name]) => parent === dir && base === name)) return true;
	}
	return segs.some((seg) => SENSITIVE_DIR_NAMES.has(seg));
}
