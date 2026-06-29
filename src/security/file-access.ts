import { resolve, relative, dirname, basename, join, isAbsolute, sep } from "node:path";
import { realpathSync } from "node:fs";
import type { SecurityDecision } from "../types.js";
import { USER_HINTS } from "../types.js";
import type { FileAccessMode } from "./types.js";
import { isAppAtRestSecretBasename } from "./known-secrets.js";
import { mapUploadsRef } from "../workspace/paths.js";
import { getLaxDir } from "../lax-data-dir.js";

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
export function matchesSensitivePath(normalized: string): RegExp | "app-at-rest-secret" | null {
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

/**
 * Confine a caller-supplied path to `root`, symlink-safe. For HTTP file-serving
 * routes that read a user-supplied path under a fixed root (app files, the
 * static /uploads//videos//images//files//apps/ sinks). Returns the canonical
 * on-disk path to use, or `null` if the request escapes `root` lexically OR
 * through a symlink/junction, or resolves to a sensitive file.
 *
 * The per-route `startsWith(root)` / `relative(root,p).startsWith("..")` guards
 * were string-only: they collapse `..` but do NOT resolve symlinks, so a symlink
 * planted inside the root (a prompt-injected agent can `ln -s ~/.lax/auth.json
 * workspace/apps/foo/x.txt`) is followed on read, and a bare `startsWith` also
 * admits a sibling dir that shares the name as a string prefix. Canonicalizing
 * BOTH sides with realpathDeep (resolves every segment) and comparing with
 * relative() closes both, and matchesSensitivePath() reproduces the file-tool
 * sensitivity gate these raw routes skipped.
 */
export function confineToDir(root: string, requestedPath: string): string | null {
  if (root.includes("\x00") || requestedPath.includes("\x00")) return null;
  let realRoot: string;
  let realPath: string;
  try {
    realRoot = realpathDeep(resolve(root));
    realPath = realpathDeep(resolve(realRoot, requestedPath));
  } catch {
    return null; // ELOOP (symlink cycle) → treat as an attack
  }
  const rel = relative(realRoot, realPath);
  if (rel === ".." || rel.startsWith(".." + sep) || isAbsolute(rel)) return null;
  const normalized = process.platform === "win32" ? realPath.toLowerCase() : realPath;
  if (matchesSensitivePath(normalized)) return null;
  return realPath;
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
  // A "/uploads/<f>" attachment ref must resolve to the uploads dir EXACTLY as
  // resolveAgentPath (the file tool) does — via the one shared mapper — or the
  // gate checks a root-level "/uploads/x" that is outside the workspace and
  // denies the read in workspace/common mode while the tool would open the real
  // file (resolution TOCTOU + the attachment false-deny this fixes).
  const resolved = mapUploadsRef(rawPath)
    ?? (isAbsolute(rawPath)
      ? resolve(rawPath)
      : resolve(rawWorkspace, "..", rawPath));

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
      // The agent's own data dir. Derive it from getLaxDir() — the ONE resolver
      // that honors LAX_DATA_DIR — not an inlined `~/.lax`, so this allow-set and
      // the place uploads/memory/config actually live (uploadsDir() etc.) can't
      // split-brain. realpathDeep so a symlinked data dir (e.g. /tmp→/private/tmp)
      // compares like-with-like against the realpath'd target.
      const laxDir = realpathDeep(resolve(getLaxDir()));
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

// The validated-inode open/read/write helpers (openValidatedRead /
// readValidatedFile / writeValidatedFile) live in ./validated-io.ts — they
// consume realpathDeep + matchesSensitivePath from here and are imported
// directly by the tool sinks, keeping this module to the policy decision.
