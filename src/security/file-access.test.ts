import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { join } from "node:path";
import {
  mkdtempSync,
  mkdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
  symlinkSync,
  unlinkSync,
  closeSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { evaluateFileAccess, openValidatedRead, readValidatedFile } from "./file-access.js";

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
  it("reads the benign target when notes.txt → safe.txt (gate would ALLOW)", () => {
    try { unlinkSync(LINK); } catch { /* not present */ }
    symlinkSync(SAFE, LINK);
    // The gate ALLOWs this — the realpath is safe.txt, not sensitive.
    const d = evaluateFileAccess(WORKSPACE, "unrestricted", () => false, "read", LINK);
    expect(d.allowed).toBe(true);
    expect(d.canonicalPath).toBe(realpathSync(SAFE));
    // The read helper returns the benign bytes.
    expect(readValidatedFile(LINK).toString("utf-8")).toBe("safe contents\n");
  });

  it("does NOT return the sensitive bytes after the leaf is repointed to id_rsa", () => {
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

  it("opens the canonical regular file and returns its fd + canonicalPath", () => {
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
