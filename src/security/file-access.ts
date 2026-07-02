import { resolve, relative, dirname, basename, isAbsolute, sep } from "node:path";
import type { SecurityDecision } from "../types.js";
import { USER_HINTS } from "../types.js";
import type { FileAccessMode } from "./types.js";
import { isAppAtRestSecretBasename } from "./known-secrets.js";
import { classifySensitivePath } from "./sensitive-paths.js";
import { resolveAgentPathFrom, realpathDeep, sessionWorkRootOf } from "../workspace/paths.js";
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
export function matchesSensitivePath(normalized: string): RegExp | "app-at-rest-secret" | "sensitive-catalog" | null {
  for (const pattern of SENSITIVE_PATTERNS) {
    if (pattern.test(normalized)) return pattern;
  }
  // Keyword-in-name patterns catch secret DATA files but NOT source code whose
  // name happens to contain the word (passwordReset.ts). Skip them for source
  // files — the agent's own work product is never sensitive by name. Every other
  // check below (catalog, app-at-rest) still runs, so a genuinely-cataloged
  // source path is unaffected.
  if (!SOURCE_CODE_EXT.test(normalized)) {
    for (const pattern of SOURCE_NAME_KEYWORD_PATTERNS) {
      if (pattern.test(normalized)) return pattern;
    }
  }
  // The gate = its regexes ∪ the shared credential-file catalog. The catalog
  // (security/sensitive-paths.ts) is the SAME shape-checker the read-taint
  // classifier uses, so the gate is a provable SUPERSET of taint — it can never
  // miss a credential file the taint path flags (.pgpass, id_ecdsa,
  // .databrickscfg, .keychain-db, age/keys.txt, .my.cnf, …). The regexes above
  // stay additive (some match broader substrings, e.g. /id_rsa/i), so adding the
  // catalog only widens the gate — no newly-allowed sensitive reads.
  if (classifySensitivePath(normalized)) return "sensitive-catalog";
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
  /[/\\]\.netrc/i,
  /[/\\]\.npmrc/i,
  /[/\\]\.pypirc/i,
  /[/\\]auth\.json/i,
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

// Keyword-in-NAME patterns: they catch secret DATA files (passwords.txt,
// secrets.yaml, ~/.aws/credentials) and stores, but the SAME word appears in
// perfectly ordinary SOURCE filenames (passwordReset.ts, credentialsService.ts,
// secrets.ts). Applied to source code they are the exact unanchored-substring
// false positive LAX's anchored catalog (sensitive-paths.ts) was built to
// replace — and here they were quarantining legitimate coding runs. So they run
// only against NON-source paths (see matchesSensitivePath); genuine secret DATA
// files aren't source-extensioned, so they stay blocked. The AWS credentials
// file is additionally covered by the `.aws/` dir pattern above + the catalog.
const SOURCE_NAME_KEYWORD_PATTERNS = [
  /[/\\]credentials/i,
  /[/\\]secrets?\./i,
  /[/\\]password/i,
];

// A file with a source-code extension is CODE — the agent's legitimate work
// product — never a "sensitive file" merely because its name contains a security
// word. Mirrors the ARI gate's carve-out (ari-kernel/evaluate.ts): one invariant,
// both gates. The dir/extension/data-basename SENSITIVE_PATTERNS above and the
// anchored catalog still apply to source paths, so a real secret under .ssh/ or a
// cataloged credential file is unaffected.
const SOURCE_CODE_EXT =
  /\.(ts|tsx|js|jsx|mjs|cjs|py|go|rs|java|rb|php|c|cc|cpp|h|hpp|cs|swift|kt|kts|scala|m|mm|vue|svelte)$/i;

// Canonical real path — implementation moved to workspace/paths.ts (the
// work-root registry there must canonicalize with the SAME resolver the gates
// use, and importing from here would be a cycle). Re-exported so the many
// existing consumers (egress guard, shell detectors, layer-core, read-state,
// validated-io, run-sandboxed) keep their import path.
export { realpathDeep } from "../workspace/paths.js";

// A work-rooted session (auto-build chunk worker) owns its project's env
// files: scaffolding <workRoot>/.env.local with placeholders is the sanctioned
// missing-credentials recovery (chunk-review/missing-creds.ts), and the
// blanket .env deny forced workers to route around the gate (live 2026-07-02).
// Deliberately tight: ONLY conventional env basenames (".env.key"/".env.pem"
// stay blocked — they also match key/cert patterns and this must never widen
// those), ONLY under the session's registered work root (both sides
// canonical), every other sensitive pattern still blocks inside the root, and
// content-level defenses (secret-shape taint, egress guard) stay fully armed.
const CONVENTIONAL_ENV_BASENAME = /^\.env(\.(local|development|production|test|example|sample|dev|prod|staging|ci))?$/i;

function isSanctionedWorkRootEnvFile(sessionId: string | undefined, realPath: string): boolean {
  if (!CONVENTIONAL_ENV_BASENAME.test(basename(realPath))) return false;
  const workRoot = sessionWorkRootOf(sessionId);
  if (!workRoot) return false;
  const rel = relative(workRoot, realPath);
  return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
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
  // Resolve through the ONE shared resolver the file tool uses (resolveAgentPath
  // → resolveAgentPathFrom), parameterized by THIS gate's workspace. The gated
  // path is then byte-for-byte the path the tool opens — no second copy of the
  // "/uploads ref + absolute + project-root-relative" rule to drift out of sync
  // (the split-brain that silently broke attachment reads).
  const resolved = resolveAgentPathFrom(rawWorkspace, rawPath, sessionId);

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
    // Credential/secret files — sensitive in ANY project, so matched by pattern
    // everywhere (unanchored). The platform's ENGINE SOURCE (src/security.ts,
    // src/auth.ts, src/codex-client.ts, …) is deliberately NOT listed here: a
    // bare path-suffix regex like /src/auth.ts$/ ALSO matched a user app or a
    // foreign project's identically-named file and wrongly blocked the edit. The
    // engine source is protected instead by the platform-root-anchored check
    // below (inPlatform && !inWorkspace && touchesSrcOrPublic) — a strict
    // superset for the platform tree, with zero false hits outside it.
    const coreProtectedFiles = [
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
  if (match && !isSanctionedWorkRootEnvFile(sessionId, realPath)) {
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
