import { mkdir, writeFile, readFile, rm, copyFile, utimes } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { getLaxDir } from "./lax-data-dir.js";
import { createLogger } from "./logger.js";

const logger = createLogger("ota-update");

// Cleanup must never decide an update's outcome: a probe process's handles
// can linger for a couple of seconds after kill on Windows, making an
// immediate rm throw EBUSY — which previously masked the real result.
async function rmBestEffort(path: string): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    try { await rm(path, { recursive: true, force: true }); return; }
    catch (e) {
      if (attempt >= 5) {
        logger.warn(`[ota] could not remove ${path}: ${(e as Error).message} — leaving it for the next sweep`);
        return;
      }
      await new Promise(resolve => setTimeout(resolve, 600));
    }
  }
}

/**
 * Throw unless `buf` hashes to `expectedHex` (SHA-256). Tolerates the
 * `<hash>  <filename>` shape a `sha256sum` file uses by taking the first token.
 * Pure + exported so the verify gate is unit-testable without a network fetch.
 */
export function assertSha256(buf: Buffer, expectedHex: string): void {
  const want = expectedHex.trim().toLowerCase().split(/\s+/)[0] || "";
  if (!/^[0-9a-f]{64}$/.test(want)) {
    throw new Error("Update rejected: published checksum is malformed.");
  }
  const got = createHash("sha256").update(buf).digest("hex");
  if (got !== want) {
    throw new Error(`Update rejected: source checksum mismatch (expected ${want.slice(0, 12)}…, got ${got.slice(0, 12)}…).`);
  }
}

interface UpdateHistoryEntry {
  version: string;
  appliedAt: string;
  status: "applied" | "rolled-back";
  previousVersion: string;
}

function shell(cmd: string, args: string[], cwd?: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { cwd, timeout: 120000 }, (err, stdout) => {
      if (err) reject(err);
      else resolve(stdout.toString().trim());
    });
  });
}

export class OTAManager {
  private laxDir: string;
  private historyPath: string;
  private backupDir: string;
  private updatesDir: string;
  private installedCommitPath: string;
  private repoOwner: string;
  private repoName: string;

  constructor(
    repoOwner = "Local-Agent-X",
    repoName = "Local-Agent-X",
    laxDir?: string
  ) {
    this.repoOwner = repoOwner;
    this.repoName = repoName;
    this.laxDir = laxDir ?? getLaxDir();
    this.historyPath = join(this.laxDir, "update-history.json");
    this.backupDir = join(this.laxDir, "backups");
    this.updatesDir = join(this.laxDir, "updates");
    this.installedCommitPath = join(this.laxDir, "installed-source.json");
  }

  // ── Rolling channel (tarball installs that track `main`) ──
  //
  // A git checkout knows its commit via `git rev-parse`; a tarball install
  // doesn't, so we record the commit we last applied here and compare it to
  // remote main HEAD to decide "is there an update".

  async readInstalledCommit(): Promise<string | null> {
    try {
      const raw = await readFile(this.installedCommitPath, "utf-8");
      const v = JSON.parse(raw) as { commit?: string };
      return v.commit || null;
    } catch {
      return null;
    }
  }

  async writeInstalledCommit(commit: string): Promise<void> {
    await this.init();
    await writeFile(
      this.installedCommitPath,
      JSON.stringify({ commit, updatedAt: new Date().toISOString() }, null, 2),
      "utf-8"
    );
  }

  // Remote main HEAD via the unauthenticated commits API — the same public
  // reachability the installer's tarball download already depends on.
  async checkMainCommit(): Promise<{ commit: string; subject: string }> {
    const url = `https://api.github.com/repos/${this.repoOwner}/${this.repoName}/commits/main`;
    const r = await fetch(url, { headers: { Accept: "application/vnd.github+json" } });
    if (!r.ok) throw new Error(`GitHub API error: ${r.status}`);
    const data = (await r.json()) as { sha: string; commit?: { message?: string } };
    return { commit: data.sha, subject: (data.commit?.message || "").split("\n")[0] };
  }

  // Download the `main` source tarball for a SPECIFIC, already-resolved commit.
  //
  // We deliberately fetch the IMMUTABLE per-commit archive
  // (`archive/<sha>.tar.gz`) rather than the mutable branch ref
  // (`archive/refs/heads/main.tar.gz`): the branch ref can change bytes between
  // the commit-resolution call and the download, so the bytes we execute would
  // not be bound to any commit we recorded. Pinning the URL to the resolved sha
  // is the integrity binding for the rolling channel — the executed bytes ARE
  // the named commit. A non-empty commit is required; without it there is no
  // binding and we refuse to download (mirrors downloadUpdate's
  // reject-on-missing-checksum posture).
  //
  // TODO(rolling-checksum): once installer-rolling.yml publishes a SHA256SUMS
  // for the per-commit archive, also fetch + verify that here so a poisoned CDN
  // response for a valid sha URL is rejected too. The commit-pin already
  // removes the mutable-ref swap; the published checksum would add bytes-level
  // verification on top.
  async downloadMainTarball(commit: string): Promise<string> {
    if (!commit) {
      throw new Error(
        "Update rejected: no resolved commit. The rolling update must pin an immutable commit archive before downloading."
      );
    }
    await this.init();

    // Bytes-level integrity: if the `rolling` release publishes a stored source
    // asset + SHA256 for THIS commit, fetch the stored asset and verify the
    // bytes before extract — GitHub's on-demand `archive/<sha>.tar.gz` is not
    // byte-stable, so it can't be checksum-verified, but an uploaded release
    // asset is an immutable blob that can. A published checksum that MISMATCHES
    // is a hard failure (no silent fallback). If no checksum is published yet
    // (today / older commits), fall back to the commit-pinned archive — strictly
    // today's behavior, never worse. See installer-rolling.yml TODO(rolling-checksum).
    const assetBase = `https://github.com/${this.repoOwner}/${this.repoName}/releases/download/rolling/lax-source-${commit}.tar.gz`;
    try {
      const sumRes = await fetch(`${assetBase}.sha256`, { redirect: "follow" });
      if (sumRes.ok) {
        const assetRes = await fetch(assetBase, { redirect: "follow" });
        if (!assetRes.ok) throw new Error(`verified source asset fetch failed: ${assetRes.status}`);
        const buf = Buffer.from(await assetRes.arrayBuffer());
        assertSha256(buf, await sumRes.text()); // throws on mismatch/malformed
        const verifiedPath = join(this.updatesDir, `main-${commit}-verified.tar.gz`);
        await writeFile(verifiedPath, buf);
        return verifiedPath;
      }
    } catch (e) {
      // A checksum mismatch must NOT be swallowed — re-throw it.
      if (/checksum mismatch|checksum is malformed/.test((e as Error).message)) throw e;
      // Transient asset/network error → fall through to the commit-pinned archive.
    }

    const url = `https://github.com/${this.repoOwner}/${this.repoName}/archive/${commit}.tar.gz`;
    const r = await fetch(url, { redirect: "follow" });
    if (!r.ok) throw new Error(`Download failed: ${r.status}`);
    const buffer = Buffer.from(await r.arrayBuffer());
    const tarPath = join(this.updatesDir, `main-${commit}-${Date.now()}.tar.gz`);
    await writeFile(tarPath, buffer);
    return tarPath;
  }

  async init(): Promise<void> {
    for (const dir of [this.laxDir, this.backupDir, this.updatesDir]) {
      if (!existsSync(dir)) {
        await mkdir(dir, { recursive: true });
      }
    }
    if (!existsSync(this.historyPath)) {
      await writeFile(this.historyPath, "[]", "utf-8");
    }
  }

  async applyUpdate(
    tarPath: string,
    installDir: string,
    currentVersion: string,
    expectedCommit: string,
    /** Gate the extracted tree before it overwrites the install (see
     *  update-pipeline.ts validateExtractedUpdate). A failed validation
     *  removes the extract and throws — the install is never touched. */
    validate?: (extractDir: string) => Promise<{ ok: boolean; detail: string; depsChanged: boolean }>
  ): Promise<{ depsChanged: boolean }> {
    // Integrity gate: never extract bytes over the live install dir unless they
    // are bound to a resolved commit. The rolling path resolves main → sha,
    // downloads the immutable archive/<sha>.tar.gz, and passes that sha here;
    // an empty/missing commit means the bytes have no integrity binding, so we
    // REFUSE rather than `tar xzf` + copy them (mirrors the deleted
    // downloadUpdate's reject-on-missing-checksum posture). This is the single
    // chokepoint guarding the extract — see ota-update.test.ts.
    if (!expectedCommit) {
      throw new Error(
        "Update rejected: no resolved commit bound to the downloaded bytes. Refusing to extract unverified source over the install."
      );
    }

    // Extract first so we can back up exactly what this update will overwrite.
    const extractDir = join(this.updatesDir, `extract-${Date.now()}`);
    await mkdir(extractDir, { recursive: true });

    try {
      await shell("tar", ["xzf", tarPath, "-C", extractDir, "--strip-components=1"]);
    } catch {
      // Windows fallback
      await shell("powershell", [
        "-Command",
        `tar xzf "${tarPath}" -C "${extractDir}" --strip-components=1`,
      ]);
    }

    // Validation gate: run the same build/bind/smoke gates a self_edit gets,
    // against the extracted tree, BEFORE anything overwrites the install. A
    // failing candidate never lands — this replaces the old blind copy.
    let depsChanged = false;
    if (validate) {
      const verdict = await validate(extractDir);
      depsChanged = verdict.depsChanged;
      if (!verdict.ok) {
        await rmBestEffort(extractDir);
        throw new Error(`Update rejected — extracted source failed validation: ${verdict.detail}`);
      }
    }

    // Back up ONLY the install files this update overwrites — never the whole
    // install dir. For desktop builds the install dir IS the Electron userData
    // dir, so a whole-dir copy hits Singleton sockets/lock files (copyfile
    // ENOENT on SingletonCookie) and gigabytes of cache. The overlapping
    // source is all we need to roll back.
    const backupPath = join(this.backupDir, `${currentVersion}-${Date.now()}`);
    await mkdir(backupPath, { recursive: true });
    await this.backupOverlap(extractDir, installDir, backupPath);

    // apply extracted files over install dir
    await this.copyDirectory(extractDir, installDir);

    // Preserve the build-freshness signal. The extract carries a validated,
    // freshly-built dist/, but copyFile stamps copy-time mtimes and `dist`
    // sorts before `src`, so post-copy src/ ends up newer than dist/ —
    // fooling serverDistIsFresh into "stale" and triggering a redundant
    // rebuild on the next boot (the post-update "Building server updates…"
    // loop). Touch dist/index.js after the copy so the shipped build reads
    // as current for this src. Best-effort: a touch failure only costs the
    // one redundant rebuild, never correctness.
    try {
      const distIndex = join(installDir, "dist", "index.js");
      if (existsSync(distIndex)) {
        const now = new Date();
        await utimes(distIndex, now, now);
      }
    } catch (e) {
      logger.warn(`[ota] could not refresh dist mtime: ${(e as Error).message}`);
    }

    // record in history
    const newVersion = tarPath.match(/([^/\\]+)\.tar\.gz$/)?.[1] ?? "unknown";
    await this.addHistoryEntry({
      version: newVersion,
      appliedAt: new Date().toISOString(),
      status: "applied",
      previousVersion: currentVersion,
    });

    // clean up extract dir
    await rmBestEffort(extractDir);
    return { depsChanged };
  }

  async rollbackUpdate(): Promise<void> {
    const history = await this.readHistory();
    const lastApplied = [...history]
      .reverse()
      .find((e) => e.status === "applied");
    if (!lastApplied) {
      throw new Error("No update to roll back");
    }

    const backups = await this.listBackups();
    const matching = backups.find((b) =>
      b.startsWith(lastApplied.previousVersion)
    );
    if (!matching) {
      throw new Error(
        `Backup for version ${lastApplied.previousVersion} not found`
      );
    }

    lastApplied.status = "rolled-back";
    await this.writeHistory(history);
  }

  async getHistory(): Promise<UpdateHistoryEntry[]> {
    return this.readHistory();
  }

  private async readHistory(): Promise<UpdateHistoryEntry[]> {
    try {
      const raw = await readFile(this.historyPath, "utf-8");
      return JSON.parse(raw) as UpdateHistoryEntry[];
    } catch {
      return [];
    }
  }

  private async writeHistory(entries: UpdateHistoryEntry[]): Promise<void> {
    await writeFile(this.historyPath, JSON.stringify(entries, null, 2), "utf-8");
  }

  private async addHistoryEntry(entry: UpdateHistoryEntry): Promise<void> {
    const history = await this.readHistory();
    history.push(entry);
    await this.writeHistory(history);
  }

  private async listBackups(): Promise<string[]> {
    const { readdir } = await import("node:fs/promises");
    try {
      return await readdir(this.backupDir);
    } catch {
      return [];
    }
  }

  private async copyDirectory(src: string, dest: string): Promise<void> {
    const { readdir } = await import("node:fs/promises");
    await mkdir(dest, { recursive: true });
    const entries = await readdir(src, { withFileTypes: true });
    for (const entry of entries) {
      // node_modules is never copied over the install — deps are managed by a
      // junction (deps unchanged) or a post-copy `npm ci` (deps changed), per
      // validateExtractedUpdate. Walking it here both duplicates the tree and,
      // worse, overwrites native .node modules the running process holds loaded
      // → EBUSY on Windows. Junctions/symlinks are skipped for the same reason:
      // a walked junction reaches the live install's real node_modules. The
      // extract's node_modules is normally removed pre-copy, but survives when
      // junction cleanup is stuck — this enforces the invariant regardless.
      if (entry.name === "node_modules" || entry.isSymbolicLink()) continue;
      const srcPath = join(src, entry.name);
      const destPath = join(dest, entry.name);
      if (entry.isDirectory()) {
        await this.copyDirectory(srcPath, destPath);
      } else {
        await copyFile(srcPath, destPath);
      }
    }
  }

  // Back up only the install files an update will overwrite — i.e. the paths
  // present in the freshly-extracted tarball. Walks the extract, and for each
  // file copies the CURRENT install version into the backup. Install-only
  // files (node_modules, caches, Electron userData state, sockets) are never
  // touched because the tarball doesn't contain them.
  private async backupOverlap(extractDir: string, installDir: string, backupPath: string): Promise<void> {
    const { readdir, stat } = await import("node:fs/promises");
    const walk = async (rel: string): Promise<void> => {
      const entries = await readdir(join(extractDir, rel), { withFileTypes: true });
      for (const entry of entries) {
        // Mirror copyDirectory: node_modules / symlinks are never part of the
        // overwrite set, so there's nothing to back up for them.
        if (entry.name === "node_modules" || entry.isSymbolicLink()) continue;
        const childRel = rel ? join(rel, entry.name) : entry.name;
        if (entry.isDirectory()) { await walk(childRel); continue; }
        const installFile = join(installDir, childRel);
        try {
          if (!(await stat(installFile)).isFile()) continue;
          const dest = join(backupPath, childRel);
          await mkdir(dirname(dest), { recursive: true });
          await copyFile(installFile, dest);
        } catch { /* not present in install (new file) — nothing to roll back */ }
      }
    };
    await walk("");
  }
}
