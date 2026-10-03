import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { basename, dirname, join, resolve, win32 } from "node:path";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
  symlinkSync,
  unlinkSync,
  closeSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { evaluateFileAccess, confineToDir, matchesSensitivePath, pathIsWithin, realpathDeep } from "./file-access.js";
import { platformRoot } from "../../platform-root.js";
import { openValidatedRead, readValidatedFile } from "./validated-io.js";
import { isSensitivePath } from "../../data-lineage/index.js";
import { SecurityLayer } from "./layer-core.js";
import { INSTALL_CHANGE_ROUTE, installRootWriteRule, launcherRuntimeFolder, runtimeRoots } from "./install-root.js";
import { getRuntimeConfig, setRuntimeConfig } from "../../config.js";
import { _resetWindowsShellCache, portableGitBashPath, resolveWindowsShell } from "../../tools/shell-env.js";
import type { LAXConfig } from "../../types.js";
import { CAN_CREATE_DIRECTORY_LINK, CAN_CREATE_FILE_SYMLINK } from "../../symlink-capabilities.test-helper.js";

const DIRECTORY_LINK_TYPE = process.platform === "win32" ? "junction" : "dir";

// Hermetic temp root, realpath-resolved so the test's lexical paths and the
// gate's realpath'd paths agree (collapses the macOS /var → /private/var
// symlink and any <repo>/workspace relocation symlink). See layer-core.test.ts.
const ROOT = realpathSync(mkdtempSync(join(tmpdir(), "lax-fa-")));
const WORKSPACE = join(ROOT, "workspace");
afterAll(() => rmSync(ROOT, { recursive: true, force: true }));

// A synthetic "sensitive" target — NEVER touch the real ~/.ssh. The basename
// id_rsa matches SENSITIVE_PATTERNS, so the read helper must refuse it.
const SENSITIVE = join(ROOT, "id_rsa");
const SAFE = join(ROOT, "safe.txt");
const LINK = join(WORKSPACE, "notes.txt");

beforeAll(() => {
  mkdirSync(WORKSPACE, { recursive: true });
  writeFileSync(SENSITIVE, "PRIVATE KEY BYTES\n");
  writeFileSync(SAFE, "safe contents\n");
  writeFileSync(join(WORKSPACE, "plain.txt"), "hello\n");
});

describe("evaluateFileAccess returns canonicalPath", () => {
  it("populates canonicalPath (realpath) on an allowed read", () => {
    const target = join(WORKSPACE, "plain.txt");
    const d = evaluateFileAccess(WORKSPACE, "unrestricted", () => false, "read", target);
    expect(d.allowed).toBe(true);
    expect(d.canonicalPath).toBe(realpathSync(target));
  });

  it("omits canonicalPath on a blocked read (sensitive pattern)", () => {
    const d = evaluateFileAccess(WORKSPACE, "unrestricted", () => false, "read", SENSITIVE);
    expect(d.allowed).toBe(false);
    expect(d.canonicalPath).toBeUndefined();
  });
});

describe("openValidatedRead / readValidatedFile — R4-19 symlink-swap TOCTOU", () => {
  it.skipIf(!CAN_CREATE_FILE_SYMLINK)("reads the benign target when notes.txt → safe.txt (gate would ALLOW)", () => {
    try { unlinkSync(LINK); } catch { /* not present */ }
    symlinkSync(SAFE, LINK);
    // The gate ALLOWs this — the realpath is safe.txt, not sensitive.
    const d = evaluateFileAccess(WORKSPACE, "unrestricted", () => false, "read", LINK);
    expect(d.allowed).toBe(true);
    expect(d.canonicalPath).toBe(realpathSync(SAFE));
    // The read helper returns the benign bytes.
    expect(readValidatedFile(LINK).toString("utf-8")).toBe("safe contents\n");
  });

  it.skipIf(!CAN_CREATE_FILE_SYMLINK)("does NOT return the sensitive bytes after the leaf is repointed to id_rsa", () => {
    // Simulate the swap: between gate-ALLOW and open, notes.txt is repointed at
    // the sensitive target. The read helper re-canonicalizes + re-checks the
    // inode against SENSITIVE_PATTERNS, so it must refuse the sensitive bytes.
    try { unlinkSync(LINK); } catch { /* not present */ }
    symlinkSync(SENSITIVE, LINK);
    let threw = false;
    let bytes = "";
    try {
      bytes = readValidatedFile(LINK).toString("utf-8");
    } catch (e) {
      threw = true;
      expect((e as Error).message).toMatch(/sensitive path pattern|symlink/i);
    }
    expect(threw).toBe(true);
    expect(bytes).not.toContain("PRIVATE KEY BYTES");
  });

  it.skipIf(!CAN_CREATE_FILE_SYMLINK)("opens the canonical regular file and returns its fd + canonicalPath", () => {
    // A benign-named leaf that is itself a symlink to a benign-named target:
    // realpathDeep resolves past it, then O_NOFOLLOW opens the regular canonical
    // file (the race O_NOFOLLOW closes is the *canonical* leaf becoming a symlink
    // between realpath and open). Assert the canonical inode is opened.
    const realLeaf = join(WORKSPACE, "real-leaf.txt");
    const linkLeaf = join(WORKSPACE, "link-leaf.txt");
    writeFileSync(realLeaf, "benign\n");
    try { unlinkSync(linkLeaf); } catch { /* not present */ }
    symlinkSync(realLeaf, linkLeaf);
    const { fd, canonicalPath } = openValidatedRead(linkLeaf);
    expect(canonicalPath).toBe(realpathSync(realLeaf));
    closeSync(fd);
  });
});

describe("app's OWN at-rest secret files under .lax (R4-04/R4-05)", () => {
  // The app's key/seed files (audit-key, audit-key.enc, secrets.salt) must be
  // both read-blocked AND write-blocked, derived from the canonical
  // APP_AT_REST_SECRET_BASENAMES set — they were hand-omitted before.
  const laxDir = join(ROOT, ".lax");
  const auditKey = join(laxDir, "audit-key");
  const auditKeyEnc = join(laxDir, "audit-key.enc");
  const salt = join(laxDir, "secrets.salt");

  beforeAll(() => {
    mkdirSync(laxDir, { recursive: true });
    writeFileSync(auditKey, "SEED BYTES\n");
    writeFileSync(auditKeyEnc, "deadbeef\n");
    writeFileSync(salt, "SALT\n");
  });

  it("read-blocks ~/.lax/audit-key (unrestricted mode)", () => {
    const d = evaluateFileAccess(WORKSPACE, "unrestricted", () => false, "read", auditKey);
    expect(d.allowed).toBe(false);
  });

  it("read-blocks ~/.lax/audit-key.enc", () => {
    const d = evaluateFileAccess(WORKSPACE, "unrestricted", () => false, "read", auditKeyEnc);
    expect(d.allowed).toBe(false);
  });

  it("read-blocks ~/.lax/secrets.salt", () => {
    const d = evaluateFileAccess(WORKSPACE, "unrestricted", () => false, "read", salt);
    expect(d.allowed).toBe(false);
  });

  it("write-blocks ~/.lax/audit-key (coreProtectedFiles)", () => {
    // allowedPathCheck → true so we exercise the core-protected leg, not the
    // workspace-containment leg.
    const d = evaluateFileAccess(WORKSPACE, "unrestricted", () => true, "write", auditKey);
    expect(d.allowed).toBe(false);
    expect(d.reason).toMatch(/protected platform file/i);
  });

  it("write-blocks ~/.lax/audit-key.enc", () => {
    const d = evaluateFileAccess(WORKSPACE, "unrestricted", () => true, "write", auditKeyEnc);
    expect(d.allowed).toBe(false);
    expect(d.reason).toMatch(/protected platform file/i);
  });

  it("readValidatedFile refuses the audit seed at the read sink", () => {
    let threw = false;
    try { readValidatedFile(auditKey); } catch (e) {
      threw = true;
      expect((e as Error).message).toMatch(/sensitive path pattern/i);
    }
    expect(threw).toBe(true);
  });
});

describe("platform-source protection is anchored — user apps & foreign projects are NOT caught", () => {
  // The class bug: engine files (src/security.ts, src/auth.ts, …) were matched
  // by bare path-suffix, so a user app under workspace/ (or any project) with
  // an identically-named file got wrongly write-blocked. Protection now comes
  // from the platform-root-anchored check, so LAX's own src/ stays locked while
  // a user app's src/ is free. Credentials (.env, .lax secrets) stay global.
  const userAppSrc = join(WORKSPACE, "userapp", "src");

  beforeAll(() => {
    mkdirSync(userAppSrc, { recursive: true });
    writeFileSync(join(userAppSrc, "auth.ts"), "export const x = 1;\n");
    writeFileSync(join(userAppSrc, "security.ts"), "export const y = 1;\n");
  });

  it("ALLOWS editing a user app's src/auth.ts under workspace/ (was a false positive)", () => {
    const d = evaluateFileAccess(WORKSPACE, "unrestricted", () => true, "edit", join(userAppSrc, "auth.ts"));
    expect(d.allowed).toBe(true);
  });

  it("ALLOWS editing a user app's src/security.ts under workspace/", () => {
    const d = evaluateFileAccess(WORKSPACE, "unrestricted", () => true, "edit", join(userAppSrc, "security.ts"));
    expect(d.allowed).toBe(true);
  });

  it("still BLOCKS a .env write inside a user app (credential secret stays global)", () => {
    writeFileSync(join(WORKSPACE, "userapp", ".env"), "SECRET=1\n");
    const d = evaluateFileAccess(WORKSPACE, "unrestricted", () => true, "edit", join(WORKSPACE, "userapp", ".env"));
    expect(d.allowed).toBe(false);
  });
});

describe("matchesSensitivePath is a SUPERSET of isSensitivePath (shared catalog)", () => {
  // The gate (matchesSensitivePath) and the read-taint classifier (isSensitivePath)
  // both consume security/sensitive-paths.ts (classifySensitivePath), so the gate
  // can never miss a credential file the taint path flags. Before the shared
  // catalog the gate's regex list silently dropped several of these (.pgpass,
  // id_ecdsa, .databrickscfg, .keychain-db, age/keys.txt). This battery is the net:
  // for each credential path BOTH must be truthy. (On non-Windows the gate sees the
  // path as-is, so the same absolute path goes to both.)
  const credentialPaths = [
    "/Users/me/.pgpass",
    "/Users/me/.ssh/id_ecdsa",
    "/Users/me/.config/sops/age/keys.txt",
    "/Users/me/.vault-token",
    "/Users/me/.boto",
    "/Users/me/.databrickscfg",
    "/Users/me/Library/Keychains/login.keychain-db",
  ];

  for (const p of credentialPaths) {
    it(`taints AND gates: ${p}`, () => {
      expect(isSensitivePath(p)).toBe(true);
      expect(matchesSensitivePath(p)).toBeTruthy();
    });
  }
});

describe("confineToDir — symlink-safe HTTP file-route containment (round-7)", () => {
  it("returns the canonical path for an in-root file", () => {
    expect(confineToDir(WORKSPACE, "plain.txt")).toBe(realpathSync(join(WORKSPACE, "plain.txt")));
  });

  it("rejects a lexical ../ traversal out of the root", () => {
    expect(confineToDir(WORKSPACE, "../id_rsa")).toBeNull();
  });

  it.skipIf(!CAN_CREATE_FILE_SYMLINK)("rejects a symlink whose target escapes the root (symlink-follow containment)", () => {
    const link = join(WORKSPACE, "escape.txt");
    try { unlinkSync(link); } catch { /* not present */ }
    symlinkSync(SAFE, link); // SAFE lives in ROOT, outside WORKSPACE
    expect(confineToDir(WORKSPACE, "escape.txt")).toBeNull();
  });

  it.skipIf(!CAN_CREATE_FILE_SYMLINK)("rejects a symlink pointing at a sensitive file (the planted-symlink exfil)", () => {
    const link = join(WORKSPACE, "leak.txt");
    try { unlinkSync(link); } catch { /* not present */ }
    symlinkSync(SENSITIVE, link); // → id_rsa
    expect(confineToDir(WORKSPACE, "leak.txt")).toBeNull();
  });

  it.skipIf(!CAN_CREATE_FILE_SYMLINK)("allows an in-root symlink that stays inside the root (resolved to its target)", () => {
    const link = join(WORKSPACE, "alias.txt");
    try { unlinkSync(link); } catch { /* not present */ }
    symlinkSync(join(WORKSPACE, "plain.txt"), link);
    expect(confineToDir(WORKSPACE, "alias.txt")).toBe(realpathSync(join(WORKSPACE, "plain.txt")));
  });

  it("rejects an in-root file whose name matches a sensitive pattern", () => {
    writeFileSync(join(WORKSPACE, "id_rsa"), "not really a key\n");
    expect(confineToDir(WORKSPACE, "id_rsa")).toBeNull();
  });

  it("rejects a null byte in the requested path", () => {
    expect(confineToDir(WORKSPACE, "plain.txt\x00.png")).toBeNull();
  });
});

// SC-8: the file-access gate must match credential files by ANCHORED SHAPE (the
// classifySensitivePath catalog), never by an unanchored password|secret|
// credential substring. Substrings fire on ordinary non-source files a
// do-anything harness must read (docs/password-policy.md, config/credentials.yaml)
// AND on source whose name merely contains the word (passwordReset.ts) — the
// false positive that quarantined legitimate coding runs.
describe("sensitive-path gate matches by anchored shape, not keyword substring", () => {
  it("ALLOWS source files whose NAME contains a security keyword", () => {
    for (const p of [
      "/Users/x/proj/server/passwordReset.ts",
      "/Users/x/proj/src/credentialsService.ts",
      "/Users/x/proj/src/secrets.ts",
      "/Users/x/proj/lib/password_utils.py",
      "/Users/x/proj/src/AuthCredentials.tsx",
      "/Users/x/proj/pkg/secret_store.go",
    ]) {
      expect(matchesSensitivePath(p)).toBeNull();
    }
  });

  it("ALLOWS ordinary non-source docs/config whose PATH contains a security word (SC-8)", () => {
    // These were HARD-BLOCKED by the old unanchored /password/, /credentials/,
    // /secrets\./ scan even though the read-taint classifier (isSensitivePath),
    // already re-anchored to the catalog, never flags them. Gate now agrees.
    for (const p of [
      "/Users/x/proj/docs/password-policy.md",
      "/Users/x/proj/config/credentials.yaml",
      "/Users/x/proj/handbook/credentials-guide.md",
      "/Users/x/proj/audit/password_audit.log",
      "/Users/x/proj/notes/secrets-checklist.md",
    ]) {
      expect(matchesSensitivePath(p), `gate should allow ${p}`).toBeNull();
      // Gate and taint classifier must agree: neither treats a policy doc as a
      // credential file (the drift SC-8 closes).
      expect(isSensitivePath(p), `taint should not flag ${p}`).toBe(false);
    }
  });

  it("still BLOCKS genuine credential files by their cataloged shape", () => {
    for (const p of [
      "/Users/x/.aws/credentials",       // dir-scoped
      "/Users/x/proj/config/secrets.yaml", // basename secrets.yaml
      "/Users/x/proj/secrets.json",       // basename secrets.json
      "/Users/x/proj/credentials.json",   // basename credentials.json
      "/Users/x/.ssh/id_rsa",             // SSH key
      "/Users/x/proj/.env",               // env secrets
    ]) {
      expect(matchesSensitivePath(p), `gate should block ${p}`).not.toBeNull();
    }
  });

  it("still BLOCKS a source-extensioned file under a genuine secret DIR", () => {
    // .ssh/ is a hard dir pattern — a .ts under it is not exempted.
    expect(matchesSensitivePath("/Users/x/.ssh/helper.ts")).not.toBeNull();
  });
});

// Worktree-egress regression (parallel auto-build chunk agents): the parallel
// builder creates git worktrees under WORKTREE_BASE = join(os.tmpdir(),
// "lax-worktrees"). On macOS os.tmpdir() is /var/folders/…/T whose realpath is
// /private/var/folders/…/T (/var → /private/var symlink). The gate realpath-
// canonicalizes every write TARGET (realpathDeep, file-access.ts:239), so an
// allowed worktree stored under only its lexical /var spelling never matched the
// /private/var target and every chunk-agent write was hard-blocked ("cannot
// write outside home directory even in unrestricted mode"). addAllowedPath now
// stores the realpathDeep form too. Built with an EXPLICIT symlink so it is
// meaningful on Linux (where /var may not be symlinked) as well as macOS.
describe("worktree under a symlinked base (macOS /var→/private/var) matches the realpath'd target", () => {
  let realBase: string;  // the canonical on-disk worktree-parent
  let linkParent: string; // a symlink → realBase's parent (the spelling registered)
  const linkable = CAN_CREATE_DIRECTORY_LINK;
  const SESSION = "chunk-agent-1";

  beforeAll(() => {
    // realpath the temp root so ONLY the deliberately-planted symlink below is
    // the /var→/private/var-style divergence under test (not the tmpdir itself).
    const base = realpathSync(mkdtempSync(join(tmpdir(), "lax-wt-symlink-")));
    const realWtParent = join(base, "real-lax-worktrees");
    realBase = join(realWtParent, "chunk-1");
    mkdirSync(realBase, { recursive: true });
    linkParent = join(base, "link-lax-worktrees"); // symlink → realWtParent
    if (linkable) symlinkSync(realWtParent, linkParent, DIRECTORY_LINK_TYPE);
  });

  // The worktree the chunk agent is granted, spelled THROUGH the symlink (the
  // /var form), and a write target inside it (does not exist yet — a new file).
  const registeredWorktree = () => join(linkParent, "chunk-1");
  const writeTarget = () => join(linkParent, "chunk-1", "app", "layout.tsx");

  for (const mode of ["unrestricted", "common", "workspace"] as const) {
    it.skipIf(!CAN_CREATE_DIRECTORY_LINK)(`${mode} mode: ALLOWS a write to the realpath'd target of a symlink-registered worktree`, () => {
      const sec = new SecurityLayer(WORKSPACE, mode);
      sec.addAllowedPath(registeredWorktree(), SESSION);
      const d = sec.evaluate({ toolName: "write", args: { path: writeTarget(), content: "x" }, sessionId: SESSION });
      // Pre-fix: addAllowedPath stored only the /var spelling; the target
      // realpath'd to /private/var and matched nothing → BLOCKED. Post-fix the
      // realpathDeep form is stored too, so the write is ALLOWED in every mode.
      expect(d.allowed, `${mode}: ${d.reason}`).toBe(true);
    });
  }

  // Always-run invariant: realpathDeep collapses the symlink so the stored real
  // form equals the gate's realpath'd target. When symlinks are unavailable this
  // still asserts realpathDeep is identity on a plain dir (the no-op that proves
  // non-symlinked allowed paths are unchanged — more precise, never more permissive).
  it("realpathDeep of the registered (symlinked) worktree equals the canonical worktree", () => {
    const spelling = linkable ? registeredWorktree() : realBase;
    expect(realpathDeep(spelling)).toBe(realBase);
  });
});

// SC-1 / SC-4: containment must survive Windows cross-drive / UNC targets, where
// path.relative() returns an ABSOLUTE path that does NOT start with "..". The
// runtime bug is Windows-only (node:path is win32 there), so we exercise the
// pure predicate through path.win32 from this POSIX host. Pre-fix the predicate
// was `!relative().startsWith("..")` with no isAbsolute guard, so every cross-
// drive target read as "inside" — voiding confinement (SC-1) and widening ALLOW
// (SC-4). Each assertion below FAILS under that pre-fix logic.
describe("pathIsWithin is drive-aware on Windows (SC-1 / SC-4)", () => {
  it("treats a different-drive target as OUTSIDE the root", () => {
    expect(pathIsWithin("C:\\Users\\me\\workspace", "D:\\secret.txt", win32)).toBe(false);
  });

  it("treats a UNC-share target as OUTSIDE a local-drive root", () => {
    expect(pathIsWithin("C:\\Users\\me\\workspace", "\\\\server\\share\\secret.txt", win32)).toBe(false);
  });

  it("still treats a real child on the SAME drive as inside", () => {
    expect(pathIsWithin("C:\\Users\\me\\workspace", "C:\\Users\\me\\workspace\\app\\x.ts", win32)).toBe(true);
    expect(pathIsWithin("C:\\Users\\me\\workspace", "C:\\Users\\me\\workspace", win32)).toBe(true);
  });

  it("still treats a ..-escape on the same drive as outside", () => {
    expect(pathIsWithin("C:\\Users\\me\\workspace", "C:\\Users\\me\\secret.txt", win32)).toBe(false);
  });

  it("posix host (default path impl) is unaffected — normal containment holds", () => {
    expect(pathIsWithin("/a/b", "/a/b/c/d")).toBe(true);
    expect(pathIsWithin("/a/b", "/a/x")).toBe(false);
    expect(pathIsWithin("/a/b", "/a/b")).toBe(true);
  });
});

// Regression (2026-07-02 fake-keys collision): the blanket .env deny blocked
// the sanctioned missing-credentials recovery — a chunk worker scaffolding its
// OWN project's .env.local with placeholders was denied (write at 04:50Z, read
// at 20:56Z, even the chat session at 21:02Z). A session with a registered
// work root may now touch conventional env files INSIDE that root; everything
// else about the sensitive-path gate is unchanged.
describe("work-root .env carve-out", () => {
  const PROJ = join(ROOT, "workroot-proj");
  const SESSION = "agent-envtest-1";

  beforeAll(async () => {
    mkdirSync(PROJ, { recursive: true });
    writeFileSync(join(PROJ, ".env.local"), "NEXT_PUBLIC_SUPABASE_URL=https://placeholder.supabase.co\n");
    const { setSessionWorkRoot } = await import("../../workspace/paths.js");
    setSessionWorkRoot(SESSION, PROJ);
  });
  afterAll(async () => {
    const { clearSessionWorkRoot } = await import("../../workspace/paths.js");
    clearSessionWorkRoot(SESSION);
  });

  it("allows read and write of <workRoot>/.env.local for the work-rooted session", () => {
    for (const action of ["read", "write"]) {
      const d = evaluateFileAccess(WORKSPACE, "unrestricted", () => false, action, join(PROJ, ".env.local"), SESSION);
      expect(d.allowed, `${action} .env.local`).toBe(true);
    }
  });

  it("covers the conventional suffixes (.env.example, .env.development) too", () => {
    // Bare ".env" write stays blocked by coreProtectedFiles (the platform's own
    // .env) — deliberately not carved out; workers scaffold suffixed env files.
    expect(evaluateFileAccess(WORKSPACE, "unrestricted", () => false, "write", join(PROJ, ".env.example"), SESSION).allowed).toBe(true);
    expect(evaluateFileAccess(WORKSPACE, "unrestricted", () => false, "write", join(PROJ, ".env.development"), SESSION).allowed).toBe(true);
    expect(evaluateFileAccess(WORKSPACE, "unrestricted", () => false, "write", join(PROJ, ".env"), SESSION).allowed).toBe(false);
  });

  it("still blocks .env for a session WITHOUT a work root", () => {
    const d = evaluateFileAccess(WORKSPACE, "unrestricted", () => false, "read", join(PROJ, ".env.local"), "agent-other-9");
    expect(d.allowed).toBe(false);
  });

  it("still blocks an env file OUTSIDE the work root for the work-rooted session", () => {
    const d = evaluateFileAccess(WORKSPACE, "unrestricted", () => false, "read", join(ROOT, ".env.local"), SESSION);
    expect(d.allowed).toBe(false);
  });

  it("still blocks non-env sensitive files INSIDE the work root", () => {
    const d = evaluateFileAccess(WORKSPACE, "unrestricted", () => false, "read", join(PROJ, "id_rsa"), SESSION);
    expect(d.allowed).toBe(false);
  });

  it("does not widen to unconventional .env.* names that match key patterns", () => {
    const d = evaluateFileAccess(WORKSPACE, "unrestricted", () => false, "write", join(PROJ, ".env.key"), SESSION);
    expect(d.allowed).toBe(false);
  });
});

// The guard's anchor, not its pattern. Every WORKSPACE here is the hermetic
// temp root — i.e. a RELOCATED workspace, which is the shipped reality (the
// packaged app puts it under ~/Documents; a dev box can junction it there).
// Anchored to resolve(workspace, "..") the guard asked whether the platform
// lived under the temp dir, got no, and allowed every write to the real src/
// and public/ — in unrestricted mode nothing else stood behind it, and an agent
// overwrote public/css/app.css (2026-07-15). No test caught it because they all
// passed a workspace whose parent WAS the tree under test.
describe("platform-source guard is anchored to the install root, not workspace/..", () => {
  // REAL platform paths — the point is that the guard finds this tree wherever
  // the workspace happens to live, so a synthetic stand-in would test nothing.
  // Read-only: a test must never write a fixture into the repo it runs from.
  const PLATFORM_CSS = join(platformRoot(), "public", "css", "app.css");
  const PLATFORM_SRC = join(platformRoot(), "src", "index.ts");

  // allowedPathCheck returns TRUE throughout: it grants the path explicit
  // session standing (what a worktree/work-root grant does), which is both the
  // stronger invariant — platform source is unwritable even WITH standing — and
  // necessary to reach the guard at all, since test-env.ts points HOME at a
  // throwaway dir and unrestricted mode's outside-home check would fire first.
  it.each([
    ["public/", PLATFORM_CSS],
    ["src/", PLATFORM_SRC],
  ])("blocks an edit to platform %s while the workspace lives elsewhere", (_label, target) => {
    const d = evaluateFileAccess(WORKSPACE, "unrestricted", () => true, "edit", target);
    expect(d.allowed).toBe(false);
    expect(d.reason).toMatch(/platform files/);
  });

  it("blocks the write action too, not just edit", () => {
    const d = evaluateFileAccess(WORKSPACE, "unrestricted", () => true, "write", PLATFORM_CSS);
    expect(d.allowed).toBe(false);
    expect(d.reason).toMatch(/platform files/);
  });

  it("still reads platform source — the guard is write-side only", () => {
    const d = evaluateFileAccess(WORKSPACE, "unrestricted", () => true, "read", PLATFORM_CSS);
    expect(d.allowed).toBe(true);
  });

  // The !inWorkspace carve-out: user apps legitimately use a src/ convention
  // (Astro, Vite, Next). Re-anchoring must not start blocking their writes.
  it("does not block a user app's own src/ inside the relocated workspace", () => {
    const appSrc = join(WORKSPACE, "apps", "my-app", "src", "main.ts");
    mkdirSync(join(WORKSPACE, "apps", "my-app", "src"), { recursive: true });
    writeFileSync(appSrc, "// user code\n");
    const d = evaluateFileAccess(WORKSPACE, "unrestricted", () => true, "edit", appSrc);
    expect(d.allowed).toBe(true);
  });
});

// The owner's rule (2026-10-02): the whole install folder is write-protected
// for the agent except its workspace. src/ and public/ were the only protected
// parts, so an unrestricted agent could still rewrite package.json, scripts/,
// python/, dist/, config/ — anything the server loads or runs, and the
// instructions it loads into every chat. REAL install paths, read only:
// nothing here creates a file in the repo the suite runs from.
describe("the install folder is write-protected except the workspace", () => {
  const root = platformRoot();
  const real = (...parts: string[]) => realpathDeep(join(root, ...parts));
  let saved: LAXConfig;
  beforeAll(() => {
    saved = getRuntimeConfig();
    // The packaged shape: the workspace lives outside the install.
    setRuntimeConfig({ ...saved, workspace: WORKSPACE });
  });
  afterAll(() => setRuntimeConfig(saved));

  // allowedPathCheck true: even explicit session standing does not open it.
  it.each([
    [["package.json"]],
    [["scripts", "x.mjs"]],
    [["python", "x.py"]],
    [["dist", "x.js"]],
  ])("refuses an unrestricted write to <install>/%s with a reason that names the folder", (parts) => {
    const d = evaluateFileAccess(WORKSPACE, "unrestricted", () => true, "write", join(root, ...parts));
    expect(d.allowed).toBe(false);
    expect(d.reason).toContain(real(...parts));
    expect(d.reason).toMatch(/inside the Local Agent X install folder, which is write-protected except for the workspace/);
  });

  it("refuses edit and delete_file too, in every mode", () => {
    for (const mode of ["unrestricted", "common", "workspace"] as const) {
      for (const action of ["edit", "delete_file"]) {
        const d = evaluateFileAccess(WORKSPACE, mode, () => true, action, join(root, "package.json"));
        expect(d.allowed, `${mode} ${action}`).toBe(false);
        expect(d.reason).toMatch(/install folder/);
      }
    }
  });

  it("leaves reads alone", () => {
    for (const parts of [["package.json"], ["scripts"], ["src", "index.ts"]]) {
      expect(evaluateFileAccess(WORKSPACE, "unrestricted", () => false, "read", join(root, ...parts)).allowed).toBe(true);
    }
  });

  it("still allows writes in a workspace that lives outside the install", () => {
    const d = evaluateFileAccess(WORKSPACE, "unrestricted", () => false, "write", join(WORKSPACE, "notes.md"));
    expect(d.allowed).toBe(true);
  });

  // config/ is no exception (the owner's ruling, 2026-10-02): it holds the
  // agent's own instructions, loaded into every chat, and changes only
  // through self_edit in developer mode. The refusal says so, in the same
  // words the shell cage's notice uses, so the agent stops trying this lane.
  // Nothing is written: the gate only judges the path.
  it("refuses config/: the prompt, tools.json, the protected-files list, a model profile — and names the self_edit route", () => {
    for (const parts of [["config", "system-prompt.md"], ["config", "tools.json"], ["config", "protected-files.json"], ["config", "model-profiles", "x.json"]]) {
      for (const action of ["write", "edit", "delete_file"]) {
        const d = evaluateFileAccess(WORKSPACE, "unrestricted", () => true, action, join(root, ...parts));
        expect(d.allowed, `${action} ${join(...parts)}`).toBe(false);
        expect(d.reason).toContain(real(...parts));
        expect(d.reason).toContain(INSTALL_CHANGE_ROUTE);
      }
    }
    expect(INSTALL_CHANGE_ROUTE).toMatch(/self_edit, which runs only in developer mode/);
  });

  it("still reads config/", () => {
    for (const parts of [["config", "system-prompt.md"], ["config", "tools.json"], ["config", "protected-files.json"]]) {
      expect(evaluateFileAccess(WORKSPACE, "unrestricted", () => false, "read", join(root, ...parts)).allowed).toBe(true);
    }
  });

  // The developer clone: workspace/ sits inside the repo. Never created —
  // the gate resolves a not-yet-existing path through its existing ancestor.
  describe("with the workspace inside the install (developer clone)", () => {
    const inRootWs = join(root, `lax-test-workspace-${process.pid}`);
    beforeAll(() => setRuntimeConfig({ ...saved, workspace: inRootWs }));
    afterAll(() => setRuntimeConfig({ ...saved, workspace: WORKSPACE }));

    it("allows writes inside the workspace", () => {
      const d = evaluateFileAccess(inRootWs, "unrestricted", () => false, "write", join(inRootWs, "apps", "todo", "index.html"));
      expect(d.allowed, d.reason).toBe(true);
    });

    it("refuses the rest of the install, including a relative path that climbs out of the workspace", () => {
      for (const p of [join("..", "package.json"), join(root, "scripts", "x.mjs")]) {
        const d = evaluateFileAccess(inRootWs, "unrestricted", () => true, "write", p);
        expect(d.allowed, p).toBe(false);
        expect(d.reason).toMatch(/install folder/);
      }
    });
  });

  it("a workspace that contains the install does not open it", () => {
    setRuntimeConfig({ ...saved, workspace: dirname(root) });
    try {
      const d = evaluateFileAccess(dirname(root), "unrestricted", () => true, "write", join(root, "package.json"));
      expect(d.allowed).toBe(false);
    } finally {
      setRuntimeConfig({ ...saved, workspace: WORKSPACE });
    }
  });

  // The filesystem opens the install under names other than the one on disk,
  // and the JS realpath keeps whichever was typed. Each name must be refused
  // like the real one. allowedPathCheck true stands in for whatever else opens
  // a path outside the workspace (on a real box, the install sits under home).
  function refusesUnder(spelling: string): void {
    for (const parts of [["package.json"], ["src", "index.ts"], ["scripts", "new.mjs"]]) {
      const d = evaluateFileAccess(WORKSPACE, "unrestricted", () => true, "write", join(spelling, ...parts));
      expect(d.allowed, join(spelling, ...parts)).toBe(false);
      expect(d.reason).toMatch(/install folder/);
    }
  }

  it.skipIf(process.platform !== "win32")("refuses the install by its 8.3 short name, where the volume keeps one", (t) => {
    const short = spawnSync("cmd.exe", ["/d", "/s", "/c", `"for %A in ("${root}") do @echo %~sA"`], { windowsVerbatimArguments: true, encoding: "utf-8" }).stdout.trim();
    if (short.toLowerCase() === root.toLowerCase()) return t.skip();
    refusesUnder(short);
  });

  it.skipIf(process.platform !== "win32")("refuses the install named through its directory stream", (t) => {
    const stream = `${root}::$INDEX_ALLOCATION`;
    if (!existsSync(stream)) return t.skip();
    refusesUnder(stream);
  });

  // Windows compares paths without case already; this is the macOS volume,
  // where a posix comparison does not.
  it("refuses another casing of the install where the volume ignores case", (t) => {
    const upper = root.toUpperCase();
    if (upper === root || !existsSync(upper)) return t.skip();
    refusesUnder(upper);
  });
});

// The rule both layers read (file gate and macOS/Linux cage), on a synthetic install.
describe("installRootWriteRule", () => {
  const base = join(ROOT, "rule");
  const install = join(base, "install");
  const ws = join(install, "workspace");
  beforeAll(() => {
    mkdirSync(ws, { recursive: true });
    mkdirSync(join(install, "config"), { recursive: true });
  });

  it("re-allows the workspace inside the install and nothing else: config/ stays write-protected", () => {
    expect(installRootWriteRule(install, ws)).toEqual({
      root: realpathSync.native(install),
      writable: [realpathSync.native(ws)],
    });
  });

  it("re-allows nothing when the workspace lives elsewhere or contains the install", () => {
    expect(installRootWriteRule(install, WORKSPACE)?.writable).toEqual([]);
    expect(installRootWriteRule(install, base)?.writable).toEqual([]);
  });

  it("never denies the temp dir when TMPDIR points inside the install", () => {
    const tmp = join(install, "tmp");
    mkdirSync(tmp, { recursive: true });
    const env = { TMPDIR: process.env.TMPDIR, TMP: process.env.TMP, TEMP: process.env.TEMP };
    Object.assign(process.env, { TMPDIR: tmp, TMP: tmp, TEMP: tmp });
    try {
      expect(installRootWriteRule(install, WORKSPACE)?.writable).toEqual([realpathSync.native(tmp)]);
    } finally {
      for (const [k, v] of Object.entries(env)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
  });

  it("is skipped when the install root does not exist", () => {
    expect(installRootWriteRule(join(base, "missing"), ws)).toBeNull();
  });
});

// The runtimes the server runs programs from are write-protected where they
// sit outside the install: a cat.exe planted in the installer's
// PortableGit\usr\bin is what the server's next shell command runs. A
// synthetic %LOCALAPPDATA%\LocalAgentX stands in for the real one, and
// process.execPath for the node the server runs on.
describe("the runtimes the server runs programs from are write-protected", () => {
  const appData = join(ROOT, "appdata");
  const git = join(appData, "LocalAgentX", "PortableGit");
  const node = join(appData, "LocalAgentX", "node-v24.16.0-win-x64");
  let saved: { config: LAXConfig; localAppData: string | undefined; execPath: string };
  beforeAll(() => {
    mkdirSync(join(git, "bin"), { recursive: true });
    writeFileSync(join(git, "bin", "bash.exe"), "");
    mkdirSync(node, { recursive: true });
    saved = { config: getRuntimeConfig(), localAppData: process.env.LOCALAPPDATA, execPath: process.execPath };
    setRuntimeConfig({ ...saved.config, workspace: WORKSPACE });
    process.env.LOCALAPPDATA = appData;
    process.execPath = join(node, "node.exe");
    _resetWindowsShellCache();
  });
  afterAll(() => {
    setRuntimeConfig(saved.config);
    if (saved.localAppData === undefined) delete process.env.LOCALAPPDATA;
    else process.env.LOCALAPPDATA = saved.localAppData;
    process.execPath = saved.execPath;
    _resetWindowsShellCache();
  });

  // The name the filesystem gives `p`, a tail that does not exist yet kept as typed.
  const onDisk = (p: string): string => existsSync(p) ? realpathSync.native(p) : join(onDisk(dirname(p)), basename(p));

  // allowedPathCheck true: even explicit session standing does not open them.
  function refusedInside(root: string, ...paths: string[]): void {
    for (const p of paths) {
      for (const action of ["write", "edit", "delete_file"]) {
        const d = evaluateFileAccess(WORKSPACE, "unrestricted", () => true, action, p);
        expect(d.allowed, `${action} ${p}`).toBe(false);
        expect(d.reason).toContain(`inside ${onDisk(root)}, which holds programs Local Agent X runs`);
      }
    }
  }

  it.skipIf(process.platform !== "win32")("refuses the Windows shell's install root (PortableGit), not just its bin folder", () => {
    refusedInside(git, join(git, "usr", "bin", "cat.exe"), join(git, "cmd", "git.exe"), join(git, "bin", "bash.exe"));
  });

  it("refuses the folder of the node the server runs on", () => {
    refusedInside(node, join(node, "node.exe"), join(node, "npx.cmd"), join(node, "node_modules", "npm", "index.js"));
  });

  // The launcher starts the next server on the newest LocalAgentX\node-v* that
  // holds a node.exe (desktop/src/path-augment.ts portableNodeDirs).
  it.skipIf(process.platform !== "win32")("refuses a newer portable node planted beside the one in use", () => {
    refusedInside(join(appData, "LocalAgentX"), join(appData, "LocalAgentX", "node-v99.0.0-win-x64", "node.exe"));
  });

  // The shell resolver tries LocalAgentX\PortableGit before any other bash,
  // so on a box without one a bash.exe put there is the next shell.
  it.skipIf(process.platform !== "win32")("refuses creating a PortableGit where there is none", () => {
    const bare = join(ROOT, "appdata-bare");
    mkdirSync(bare, { recursive: true });
    process.env.LOCALAPPDATA = bare;
    _resetWindowsShellCache();
    try {
      expect(pathIsWithin(bare, resolveWindowsShell().path)).toBe(false);
      const portableGit = join(bare, "LocalAgentX", "PortableGit");
      refusedInside(join(bare, "LocalAgentX"), join(portableGit, "bin", "bash.exe"), join(portableGit, "usr", "bin", "cat.exe"));
    } finally {
      process.env.LOCALAPPDATA = appData;
      _resetWindowsShellCache();
    }
  });

  // The launcher puts ~/.lax/runtime/bin first on PATH (desktop/src/server-process.ts),
  // so a node put there is the next server even while this one runs on brew's.
  it.skipIf(process.platform === "win32")("refuses the app-owned node folder while the server runs on another node", () => {
    const home = join(ROOT, "posix-home");
    mkdirSync(home, { recursive: true });
    const savedHome = process.env.HOME;
    process.env.HOME = home;
    try {
      refusedInside(join(home, ".lax", "runtime"), join(home, ".lax", "runtime", "bin", "node"), join(home, ".lax", "runtime", "lib", "node_modules", "npm", "index.js"));
    } finally {
      if (savedHome === undefined) delete process.env.HOME;
      else process.env.HOME = savedHome;
    }
  });

  it("still allows a workspace write, and any read", () => {
    expect(evaluateFileAccess(WORKSPACE, "unrestricted", () => false, "write", join(WORKSPACE, "notes.md")).allowed).toBe(true);
    expect(evaluateFileAccess(WORKSPACE, "unrestricted", () => false, "read", join(node, "node.exe")).allowed).toBe(true);
  });

  it("leaves a node inside the workspace to the agent: it is its own toolchain", () => {
    const own = join(WORKSPACE, "tools", "node");
    process.execPath = join(own, "node.exe");
    try {
      const d = evaluateFileAccess(WORKSPACE, "unrestricted", () => false, "write", join(own, "node_modules", "x.js"));
      expect(d.allowed, d.reason).toBe(true);
    } finally { process.execPath = join(node, "node.exe"); }
  });

  it("keeps the workspace open when the node's folder sits around it", () => {
    process.execPath = join(ROOT, "node.exe");
    try {
      expect(evaluateFileAccess(WORKSPACE, "unrestricted", () => false, "write", join(WORKSPACE, "notes.md")).allowed).toBe(true);
      refusedInside(ROOT, join(ROOT, "node.exe"));
    } finally { process.execPath = join(node, "node.exe"); }
  });

  // The packaged app runs on its own executable, whose folder holds the
  // install. Home moves aside (never created) so the folder around the
  // install is not above it, as the temp dir often is on a developer box.
  // A path inside the install is the install rule's to judge: a workspace
  // inside it stays open, and a refusal names that rule, not the runtime.
  it("leaves the install to its own rule when the node's folder sits around it", () => {
    const around = dirname(platformRoot());
    const inRootWs = join(platformRoot(), `lax-test-workspace-${process.pid}`);
    const env = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
    const elsewhere = resolve("/", `lax-test-home-${process.pid}`);
    Object.assign(process.env, { HOME: elsewhere, USERPROFILE: elsewhere });
    process.execPath = join(around, "node.exe");
    setRuntimeConfig({ ...saved.config, workspace: inRootWs });
    try {
      expect(evaluateFileAccess(inRootWs, "unrestricted", () => false, "write", join(inRootWs, "notes.md")).allowed).toBe(true);
      const d = evaluateFileAccess(inRootWs, "unrestricted", () => true, "write", join(platformRoot(), "config", "tools.json"));
      expect(d.allowed).toBe(false);
      expect(d.reason).toMatch(/inside the Local Agent X install folder/);
      refusedInside(around, join(around, "node.exe"));
    } finally {
      setRuntimeConfig({ ...saved.config, workspace: WORKSPACE });
      process.execPath = join(node, "node.exe");
      Object.assign(process.env, env);
    }
  });

  it("does not put the home folder off limits when the node sits at its top", () => {
    process.execPath = join(homedir(), "node.exe");
    try {
      const d = evaluateFileAccess(WORKSPACE, "unrestricted", () => false, "write", join(homedir(), "notes.md"));
      expect(d.allowed, d.reason).toBe(true);
    } finally { process.execPath = join(node, "node.exe"); }
  });
});

describe("runtimeRoots", () => {
  const base = join(ROOT, "runtimes");
  const install = join(base, "install");
  const home = join(base, "home", "me");
  beforeAll(() => mkdirSync(install, { recursive: true }));

  it("names the folder of the node the server runs on", () => {
    expect(runtimeRoots(null, join(base, "node", "node.exe"), install, home, null)).toEqual([join(realpathSync.native(base), "node")]);
  });

  it("skips one inside the install, the home folder itself, and any folder above it", () => {
    for (const execPath of [join(install, "node", "node.exe"), join(home, "node.exe"), join(base, "home", "node.exe"), join(base, "node.exe")]) {
      expect(runtimeRoots(null, execPath, install, home, null), execPath).toEqual([]);
      expect(runtimeRoots(null, join(base, "node", "node.exe"), install, home, dirname(execPath)), execPath).toEqual([join(realpathSync.native(base), "node")]);
    }
  });

  it.skipIf(process.platform !== "win32")("names the Windows shell's install root, and skips a bare shell name the OS looks up at spawn", () => {
    const nodeDir = join(realpathSync.native(base), "node");
    const node = join(base, "node", "node.exe");
    expect(runtimeRoots(join(base, "Git", "bin", "bash.exe"), node, install, home, null)).toEqual([nodeDir, join(realpathSync.native(base), "Git")]);
    expect(runtimeRoots(join(home, "bin", "bash.exe"), node, install, home, null)).toEqual([nodeDir]);
    expect(runtimeRoots("powershell.exe", node, install, home, null)).toEqual([nodeDir]);
  });

  // Not yet created: a folder the launcher would search is protected before
  // anything is in it, or the agent could be the one to fill it.
  it("names the folder the launcher picks the next runtime from, after the runtime in use", () => {
    const launcher = join(base, "appdata", "LocalAgentX");
    expect(runtimeRoots(null, join(base, "node", "node.exe"), install, home, launcher))
      .toEqual([join(realpathSync.native(base), "node"), join(realpathSync.native(base), "appdata", "LocalAgentX")]);
  });
});

// The same folder the desktop launcher searches (pinned against it in
// test/desktop-path-augment.test.ts).
describe("launcherRuntimeFolder", () => {
  it("is LocalAgentX under %LOCALAPPDATA% on Windows, where PortableGit lives too", () => {
    const local = join(ROOT, "AppData", "Local");
    expect(launcherRuntimeFolder("win32", homedir(), local)).toBe(join(local, "LocalAgentX"));
    expect(portableGitBashPath(local)).toBe(join(local, "LocalAgentX", "PortableGit", "bin", "bash.exe"));
  });

  it("is none on Windows without %LOCALAPPDATA%", () => {
    const saved = process.env.LOCALAPPDATA;
    delete process.env.LOCALAPPDATA;
    try {
      expect(launcherRuntimeFolder("win32", homedir())).toBeNull();
    } finally {
      if (saved !== undefined) process.env.LOCALAPPDATA = saved;
    }
  });

  it("is the app-owned node under ~/.lax/runtime elsewhere", () => {
    for (const platform of ["darwin", "linux"] as const) {
      expect(launcherRuntimeFolder(platform, join(ROOT, "me"), undefined)).toBe(join(ROOT, "me", ".lax", "runtime"));
    }
  });
});
