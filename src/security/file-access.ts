import { resolve, relative, dirname, basename, join, isAbsolute } from "node:path";
import { realpathSync } from "node:fs";
import type { SecurityDecision } from "../types.js";
import { USER_HINTS } from "../types.js";
import type { FileAccessMode } from "./types.js";

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
function realpathDeep(target: string): string {
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
    const homeDir = resolve(process.env.HOME || process.env.USERPROFILE || "");

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
      const inProject = !relative(projectRoot, realPath).startsWith("..");
      const inLax = !relative(laxDir, realPath).startsWith("..");
      const inExtraAllowed = allowedPathCheck(realPath, sessionId);

      if (fileAccessMode === "workspace") {
        if (!inProject && !inLax && !inExtraAllowed) {
          return { allowed: false, reason: "Blocked: workspace mode — reads restricted to project directory only. Change to 'common' mode in Settings to access Downloads, Documents, etc.", userHint: USER_HINTS.fileSystem };
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
    for (const pattern of coreProtectedFiles) {
      if (pattern.test(resolved) || pattern.test(realPath)) {
        return {
          allowed: false,
          reason: `Blocked: protected platform file. Use the apps system to build custom interfaces.`,
          userHint: USER_HINTS.secrets,
        };
      }
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
  for (const pattern of SENSITIVE_PATTERNS) {
    if (pattern.test(normalizedResolved) || pattern.test(normalizedRealPath)) {
      return {
        allowed: false,
        reason: `Blocked: matches sensitive path pattern ${pattern.source}`,
        userHint: USER_HINTS.secrets,
      };
    }
  }

  return { allowed: true, reason: "File access allowed" };
}
