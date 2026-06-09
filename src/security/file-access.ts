import { resolve, relative, dirname, basename, join, isAbsolute } from "node:path";
import { realpathSync, openSync, closeSync, readFileSync, writeFileSync, constants } from "node:fs";
import type { SecurityDecision } from "../types.js";
import { USER_HINTS } from "../types.js";
import type { FileAccessMode } from "./types.js";
import { isAppAtRestSecretBasename } from "./known-secrets.js";

// ── The app's OWN at-rest secret/key/seed files under a `.lax` data dir ──
//
// Derived from the ONE canonical enumeration (security/known-secrets.ts) so this
// read gate / write block can never drift from the read-taint classifier or the
// attachment denylist. We scope the match to a `.lax` dir segment so a user file
// that happens to be named e.g. `auth.json` outside the data dir isn't caught by
// THIS rule (auth.json/master.* still match the cross-location SENSITIVE_PATTERNS
// below where they already did) — the new coverage this adds is `audit-key` /
// `audit-key.enc` / `secrets.salt` under the app's data dir.
function isAppAtRestSecretUnderLax(p: string): boolean {
  const segs = p.split(/[\\/]/).filter(Boolean);
  if (segs.length < 2) return false;
  if (!isAppAtRestSecretBasename(segs[segs.length - 1])) return false;
  for (let i = 0; i < segs.length - 1; i++) {
    if (segs[i].toLowerCase() === ".lax") return true;
  }
  return false;
}

// Whether a (already case-normalized) path matches any always-blocked sensitive
// rule: the regex catalog below OR the app's own at-rest key/seed files under
// its data dir. ONE checker so the pre-dispatch gate and the read sink stay in
// lockstep.
function matchesSensitivePath(normalized: string): RegExp | "app-at-rest-secret" | null {
  for (const pattern of SENSITIVE_PATTERNS) {
    if (pattern.test(normalized)) return pattern;
  }
  if (isAppAtRestSecretUnderLax(normalized)) return "app-at-rest-secret";
  return null;
}

// ── Sensitive path patterns (always blocked for read/write/edit) ──

const SENSITIVE_PATTERNS = [
  /[/\\]\.ssh[/\\]/i,
  /[/\\]\.aws[/\\]/i,
  /[/\\]\.gnupg[/\\]/i,
  /[/\\]\.kube[/\\]/i,
  /[/\\]\.env$/i,
  /[/\\]\.env\./i,
  /id_rsa/i,
  /id_ed25519/i,
  /[/\\]credentials/i,
  /[/\\]\.netrc/i,
  /[/\\]\.npmrc/i,
  /[/\\]\.pypirc/i,
  /[/\\]auth\.json/i,
  /[/\\]secrets?\./i,
  /[/\\]password/i,
  /[/\\]\.git[/\\]config/i,
  /[/\\]\.docker[/\\]config\.json/i,         // Docker credentials
  /[/\\]\.kube[/\\]config/i,                 // Kubernetes config
  /\.pem$/i,                                  // PEM certificates/keys
  /\.key$/i,                                  // Private key files
  /\.p12$/i,                                  // PKCS12 files
  /\.pfx$/i,                                  // PFX files
  /\.jks$/i,                                  // Java keystore
  /[/\\]\.config[/\\]gcloud/i,               // Google Cloud config
  /[/\\]\.azure[/\\]/i,                       // Azure config
  /[/\\]\.terraform[/\\]/i,                   // Terraform state
  /terraform\.tfstate/i,                      // Terraform state file
  /[/\\]\.vault-token/i,                      // HashiCorp Vault token
  /[/\\]\.boto$/i,                            // AWS boto config
];

// Canonical real path that follows symlinks/junctions at every EXISTING
// segment. For a target that doesn't exist yet (write to a new file), the
// deepest existing ancestor is canonicalized and the absent tail re-appended,
// so a junction in the parent chain is resolved while the new leaf is kept.
// Rethrows only ELOOP (symlink cycle) so the caller can treat it as an attack.
//
// Exported so the egress-attachment guard (http-egress-guard.ts) canonicalizes
// an attachment path the SAME way the file tools do BEFORE running its
// sensitivity predicate — closing the check-on-string / read-on-inode TOCTOU
// where a symlink (/tmp/notes.txt → ~/.ssh/id_rsa) sails past a lexical check.
export function realpathDeep(target: string): string {
  let tail = "";
  let cur = target;
  for (let i = 0; i < 64; i++) {
    try {
      const real = realpathSync(cur);
      return tail ? resolve(real, tail) : real;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ELOOP") throw e;
      const parent = dirname(cur);
      if (parent === cur) return target; // reached filesystem root unresolved
      tail = tail ? join(basename(cur), tail) : basename(cur);
      cur = parent;
    }
  }
  return target;
}

// Folder names common mode treats as the user's own content.
const USER_FOLDER_NAMES = ["Downloads", "Documents", "Desktop", "Pictures", "Videos", "Music"];

// The directories common mode allows reads from. A literal ~/<Folder> list is
// wrong on Windows when OneDrive "Known Folder Move" is on: Documents, Desktop,
// and Pictures are redirected to %OneDrive%\<Folder> (e.g.
// C:\Users\me\OneDrive\Documents), so checking only ~/Documents misses the
// user's REAL Documents and common mode wrongly blocks it — the user had to go
// fully unrestricted just to read their own spreadsheet. OneDrive exports its
// root via env vars (OneDrive / OneDriveConsumer / OneDriveCommercial); read
// those and add the same folders under each root. Env-var lookups only — no
// filesystem probing, because this runs on every file tool call. Unset on
// non-OneDrive / non-Windows machines, so their behavior is unchanged.
// (A non-OneDrive KFM redirect to another drive would need the known-folder
// registry; OneDrive is the dominant case and is covered without that cost.)
function userContentDirs(homeDir: string): string[] {
  const roots = new Set<string>([resolve(homeDir)]);
  for (const envVar of ["OneDrive", "OneDriveConsumer", "OneDriveCommercial"]) {
    const root = process.env[envVar];
    if (root && root.trim()) roots.add(resolve(root));
  }
  const dirs: string[] = [];
  for (const root of roots) {
    for (const name of USER_FOLDER_NAMES) dirs.push(resolve(root, name));
  }
  return dirs;
}

export function evaluateFileAccess(
  workspace: string,
  fileAccessMode: FileAccessMode,
  allowedPathCheck: (realPath: string, sessionId?: string) => boolean,
  action: string,
  rawPath: string,
  sessionId?: string,
): SecurityDecision {
  if (rawPath.includes("\x00")) {
    return { allowed: false, reason: "Blocked: null byte in file path", userHint: USER_HINTS.fileSystem };
  }

  // Resolve a RELATIVE agent path the SAME way the file tool that opens it does
  // (src/workspace/paths.ts → resolveAgentPath): anchored to the PROJECT ROOT
  // (workspace parent), never process.cwd(). Anchoring both sides to the same
  // root means the gated path is byte-for-byte the opened path — no resolution
  // TOCTOU. Absolute paths (incl. the sql layer's pre-resolved db path) pass
  // through unchanged.
  const rawWorkspace = resolve(workspace);
  const resolved = isAbsolute(rawPath)
    ? resolve(rawPath)
    : resolve(rawWorkspace, "..", rawPath);

  // Canonicalize BOTH the workspace root and the target to their real on-disk
  // paths before any containment check. realpathSync follows symlinks AND
  // Windows directory junctions at EVERY segment, not just the final one. The
  // agent workspace is commonly relocated (packaged app → ~/Documents) and
  // bridged back to <cwd>/workspace by a junction; a path traversing that
  // junction is lexically "outside" config.workspace but physically inside it.
  // lstat on the final segment can't see a mid-path junction — resolving the
  // whole path (and the workspace the same way) keeps the two comparable.
  workspace = realpathDeep(rawWorkspace);
  let realPath: string;
  try {
    realPath = realpathDeep(resolved);
  } catch (e) {
    // ELOOP = symlink cycle (attack). realpathDeep only rethrows this; ENOENT
    // for a not-yet-created write target is handled internally (ancestor walk).
    if ((e as NodeJS.ErrnoException).code === "ELOOP") {
      return { allowed: false, reason: "Blocked: symlink loop detected (possible attack)", userHint: USER_HINTS.fileSystem };
    }
    realPath = resolved;
  }

  // Check for directory traversal (.. in path after resolution)
  const rel = relative(workspace, realPath);
  if (rel.startsWith("..")) {
    // Canonicalize home the SAME way the target was (realpathDeep above), so the
    // containment checks compare like with like. realPath has every symlink
    // segment resolved; a non-realpath'd home breaks the comparison whenever the
    // home prefix is itself a symlink (macOS temp homes live under /var, which is
    // a symlink to /private/var; a relocated/junctioned home does the same), and
    // common mode then wrongly blocks the user's own Documents/Downloads.
    const homeDir = realpathDeep(resolve(process.env.HOME || process.env.USERPROFILE || ""));

    // Unrestricted mode: allow reads/writes anywhere (except core protected files and system dirs)
    if (fileAccessMode === "unrestricted") {
      // Hard-block writes to system directories — even unrestricted mode can't touch these
      if (action === "write" || action === "edit") {
        const SYSTEM_DIRS = process.platform === "win32"
          ? [/^[A-Z]:\\Windows\\/i, /^[A-Z]:\\Program Files/i, /^[A-Z]:\\ProgramData\\/i, /^[A-Z]:\\System/i]
          : [/^\/etc\//, /^\/sys\//, /^\/proc\//, /^\/boot\//, /^\/usr\/(?:bin|sbin|lib)\//, /^\/sbin\//, /^\/bin\//, /^\/dev\//];
        for (const sysDir of SYSTEM_DIRS) {
          if (sysDir.test(realPath)) {
            return { allowed: false, reason: `Blocked: cannot write to system directory even in unrestricted mode`, userHint: USER_HINTS.fileSystem };
          }
        }
        const projectRoot = resolve(workspace, "..");
        const inProject = !relative(projectRoot, realPath).startsWith("..");
        const inHome = !relative(homeDir, realPath).startsWith("..");
        const inAllowed = allowedPathCheck(realPath, sessionId);
        if (!inProject && !inHome && !inAllowed) {
          return { allowed: false, reason: "Blocked: cannot write outside home directory even in unrestricted mode", userHint: USER_HINTS.fileSystem };
        }
      }
      // Reads: allowed everywhere
    } else {
      // Workspace + Common modes: block writes outside workspace (allow worktree paths)
      if (action === "write" || action === "edit") {
        const inWt = allowedPathCheck(realPath, sessionId);
        if (!inWt) return { allowed: false, reason: "Blocked: cannot write files outside workspace directory", userHint: USER_HINTS.fileSystem };
      }

      // Reads: check based on mode
      const projectRoot = resolve(workspace, "..");
      const laxDir = resolve(homeDir, ".lax");
      const inWorkspace = !relative(workspace, realPath).startsWith("..");
      const inProject = !relative(projectRoot, realPath).startsWith("..");
      const inLax = !relative(laxDir, realPath).startsWith("..");
      const inExtraAllowed = allowedPathCheck(realPath, sessionId);

      if (fileAccessMode === "workspace") {
        // Workspace-only is the WORKSPACE folder itself + everything under it,
        // plus the agent's own data dir (~/.lax: memory/config) and any session
        // worktree. NOT the workspace's PARENT — a user who points the workspace
        // at e.g. C:\Users\me\workspace must not thereby expose all of
        // C:\Users\me. (Children of the workspace are reachable via inWorkspace.)
        if (!inWorkspace && !inLax && !inExtraAllowed) {
          return { allowed: false, reason: "Blocked: workspace mode — reads restricted to the workspace folder only. Change to 'common' mode in Settings to access Downloads, Documents, etc.", userHint: USER_HINTS.fileSystem };
        }
      } else {
        const inUserDir = userContentDirs(homeDir).some((d) => !relative(d, realPath).startsWith(".."));
        if (!inProject && !inLax && !inUserDir && !inExtraAllowed) {
          return { allowed: false, reason: "Blocked: cannot read files outside project and user directories. Change to 'unrestricted' mode in Settings for full access.", userHint: USER_HINTS.fileSystem };
        }
      }
    }
  }

  // Block writes/edits to core agent files — CODE ENFORCED, not just documented
  // Even if the AI is prompt-injected, it CANNOT weaken its own security
  if (action === "write" || action === "edit") {
    const coreProtectedFiles = [
      /[/\\]src[/\\]security\.ts$/i,        // Security layer — guardrails
      /[/\\]src[/\\]auth\.ts$/i,            // Auth — token handling
      /[/\\]src[/\\]codex-client\.ts$/i,    // API client — token transport
      /[/\\]src[/\\]keychain\.ts$/i,        // Encryption key management
      /[/\\]src[/\\]sanitize\.ts$/i,        // Prompt injection defense
      /[/\\]src[/\\]threat-engine\.ts$/i,   // Threat detection / canary tokens
      /[/\\]src[/\\]rbac\.ts$/i,            // Role-based access control
      /[/\\]src[/\\]safe-regex\.ts$/i,      // Regex safety
      /[/\\]src[/\\]tool-policy\.ts$/i,     // Tool policy enforcement
      /[/\\]\.env$/i,                        // Environment secrets
      /[/\\]\.lax[/\\]secrets\./i,           // Encrypted secrets store
      /[/\\]\.lax[/\\]master\./i,            // Master encryption key
      /[/\\]\.lax[/\\]auth\.json$/i,         // OAuth tokens
    ];
    // The app's OWN at-rest key/seed files under its `.lax` data dir
    // (audit-key, audit-key.enc, secrets.*, master.*, secrets.salt, auth.json).
    // Derived from the ONE canonical enumeration (security/known-secrets.ts) so a
    // tool can't write/overwrite a key file the read-taint path also covers — the
    // `secrets.`/`master.`/`auth.json` regexes below predate the audit seed and
    // missed `audit-key`/`audit-key.enc`/`secrets.salt`; deriving here closes that.
    const blockedByCorePattern =
      isAppAtRestSecretUnderLax(resolved) ||
      isAppAtRestSecretUnderLax(realPath) ||
      coreProtectedFiles.some((pattern) => pattern.test(resolved) || pattern.test(realPath));
    if (blockedByCorePattern) {
      return {
        allowed: false,
        reason: `Blocked: protected platform file. Use the apps system to build custom interfaces.`,
        userHint: USER_HINTS.secrets,
      };
    }

    // Block writes to the LAX platform's own source. <repoRoot>/src and
    // <repoRoot>/public ARE the platform — but the check is anchored to the
    // repo root, NOT a bare "/src/" substring. User apps live under workspace/
    // and legitimately use a src/ convention (Astro mandates src/pages/; Vite,
    // Next, Vue, SvelteKit all use src/) — those must NOT be caught. workspace/
    // is the user-app sandbox; everything else under the repo is platform.
    const projectRoot = resolve(workspace, "..");
    const inWorkspace = !relative(workspace, realPath).startsWith("..");
    const inPlatform = !relative(projectRoot, realPath).startsWith("..");
    const touchesSrcOrPublic = /[/\\](src|public)[/\\]/i.test(realPath);
    if (inPlatform && !inWorkspace && touchesSrcOrPublic) {
      return {
        allowed: false,
        reason: `Blocked: cannot modify platform files (src/ or public/). Build apps under workspace/ instead.`,
        userHint: USER_HINTS.secrets,
      };
    }
  }

  // Check sensitive paths against both resolved and real paths
  const normalizedResolved = process.platform === "win32" ? resolved.toLowerCase() : resolved;
  const normalizedRealPath = process.platform === "win32" ? realPath.toLowerCase() : realPath;
  const match = matchesSensitivePath(normalizedResolved) ?? matchesSensitivePath(normalizedRealPath);
  if (match) {
    return {
      allowed: false,
      reason: `Blocked: matches sensitive path pattern ${typeof match === "string" ? match : match.source}`,
      userHint: USER_HINTS.secrets,
    };
  }

  // Hand back the canonical inode the checks above bound to (realPath). The
  // read sinks open THIS path with O_NOFOLLOW (see openValidatedRead) instead
  // of re-deriving a raw lexical path, so the inode validated here is the inode
  // opened — closing the symlink-swap TOCTOU (R4-19).
  return { allowed: true, reason: "File access allowed", canonicalPath: realPath };
}

// fs.constants.O_NOFOLLOW is POSIX-only; on Windows it is undefined. Falling
// back to 0 leaves the open flags unchanged there — the realpath-then-revalidate
// leg still applies, and Windows symlink creation requires elevation, so the
// residual risk is lower. (O_RDONLY is 0 on every platform, so this OR is the
// read-only flag set with NOFOLLOW added where the platform supports it.)
const READ_NOFOLLOW_FLAGS = constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0);

/**
 * Open the VALIDATED canonical inode for a READ sink, atomically closing the
 * check-on-string / open-on-inode TOCTOU (R4-19). Mirrors the email tool's
 * canonicalizeAttachmentPath pattern (re-canonicalize so the checked inode is
 * the read inode), and hardens it the way checkAttachmentPaths could not: the
 * leaf is opened with O_NOFOLLOW, so a symlink swapped in at the canonical leaf
 * BETWEEN realpath and open is rejected (ELOOP) rather than followed.
 *
 * Steps:
 *   1. realpathDeep(absPath) — follow every existing symlink/junction segment,
 *      exactly as the pre-dispatch gate did, so we bind to the same inode.
 *   2. Re-check that inode against SENSITIVE_PATTERNS. The gate already ran the
 *      mode/containment check on this realpath; re-running the inode-bound
 *      sensitivity check here means a leaf repointed at ~/.ssh/id_rsa after the
 *      gate is caught at open time. (Mode/containment is NOT re-evaluated here:
 *      the active mode + worktree allowlist are SecurityLayer instance state not
 *      available at the sink, and re-deriving them would risk false-blocking a
 *      legitimate worktree read; the sensitivity rules are mode-independent and
 *      are the leg that actually defeats the id_rsa swap.)
 *   3. openSync(realPath, O_RDONLY | O_NOFOLLOW). If the leaf is now a symlink,
 *      the kernel rejects the open with ELOOP — fail closed.
 *
 * Returns the open fd plus the canonical path so the caller can fstat/read the
 * exact inode it just validated. The caller MUST close the fd. A genuine open
 * error (ENOENT, EACCES, ELOOP, …) is surfaced, never swallowed.
 */
export function openValidatedRead(absPath: string): { fd: number; canonicalPath: string } {
  let canonicalPath: string;
  try {
    canonicalPath = realpathDeep(absPath);
  } catch (e) {
    // ELOOP = symlink cycle (attack). realpathDeep only rethrows this.
    if ((e as NodeJS.ErrnoException).code === "ELOOP") {
      throw new Error("Blocked: symlink loop detected (possible attack)");
    }
    throw e;
  }

  const normalized = process.platform === "win32" ? canonicalPath.toLowerCase() : canonicalPath;
  const match = matchesSensitivePath(normalized);
  if (match) {
    throw new Error(`Blocked: matches sensitive path pattern ${typeof match === "string" ? match : match.source}`);
  }

  // O_NOFOLLOW on the leaf: a symlink swapped in at canonicalPath between the
  // realpath above and this open is rejected (ELOOP) rather than followed.
  const fd = openSync(canonicalPath, READ_NOFOLLOW_FLAGS);
  return { fd, canonicalPath };
}

/**
 * Convenience wrapper over {@link openValidatedRead} for sinks that just want
 * the bytes: opens the validated canonical inode with O_NOFOLLOW, reads it
 * fully, and closes the fd. Preserves the caller's own size caps / encoding —
 * it returns a raw Buffer and never swallows an open or read error.
 */
export function readValidatedFile(absPath: string): Buffer {
  const { fd } = openValidatedRead(absPath);
  try {
    return readFileSync(fd);
  } finally {
    closeSync(fd);
  }
}

// O_WRONLY | O_CREAT | O_TRUNC, plus O_NOFOLLOW where the platform supports it
// (POSIX-only; undefined on Windows → 0, same fallback as the read flags). The
// NOFOLLOW makes the kernel REJECT the open (ELOOP) if the final path component
// is a symlink, so a pre-planted symlink at the write target can't redirect the
// write to overwrite a file OUTSIDE the workspace (R4-19 write leg). NOFOLLOW
// only guards the LEAF; the parent chain is resolved normally, which is fine —
// the pre-dispatch gate already realpath-confined the whole path.
const WRITE_NOFOLLOW_FLAGS = constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | (constants.O_NOFOLLOW ?? 0);

/**
 * Write `data` to `absPath` with O_NOFOLLOW on the leaf, atomically closing the
 * symlink-redirect leg of R4-19 for write sinks. Mirrors {@link openValidatedRead}:
 * the caller has already path-confined `absPath` through the pre-dispatch gate;
 * this opens the target itself (not via the high-level writeFileSync(path)) so a
 * symlink swapped in at the leaf is rejected (ELOOP) rather than followed off-box.
 *
 * The parent directory is expected to exist (callers mkdir -p first). A genuine
 * open/write error (ELOOP for a symlinked target, EACCES, …) is surfaced, never
 * swallowed. The caller-supplied `mode` is the create mode for a new file.
 */
export function writeValidatedFile(absPath: string, data: string | Buffer, mode = 0o644): void {
  const fd = openSync(absPath, WRITE_NOFOLLOW_FLAGS, mode);
  try {
    writeFileSync(fd, data);
  } finally {
    closeSync(fd);
  }
}
