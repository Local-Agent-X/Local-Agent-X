import { createHash } from "node:crypto";
import { mkdir, writeFile, readFile, rm, copyFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { getLaxDir } from "./lax-data-dir.js";

export interface UpdateInfo {
  version: string;
  tag: string;
  tarballUrl: string;
  sha256: string;
  releaseNotes: string;
  publishedAt: string;
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

  // Download the latest `main` source tarball. Unlike downloadUpdate (release
  // assets, checksum-verified), main publishes no SHA256SUMS — integrity rests
  // on HTTPS plus the extract. Returns the local tarball path for applyUpdate.
  async downloadMainTarball(): Promise<string> {
    await this.init();
    const url = `https://github.com/${this.repoOwner}/${this.repoName}/archive/refs/heads/main.tar.gz`;
    const r = await fetch(url, { redirect: "follow" });
    if (!r.ok) throw new Error(`Download failed: ${r.status}`);
    const buffer = Buffer.from(await r.arrayBuffer());
    const tarPath = join(this.updatesDir, `main-${Date.now()}.tar.gz`);
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

  async checkForUpdates(currentVersion: string): Promise<UpdateInfo | null> {
    const url = `https://api.github.com/repos/${this.repoOwner}/${this.repoName}/releases/latest`;
    const response = await fetch(url, {
      headers: { Accept: "application/vnd.github+json" },
    });

    if (!response.ok) {
      throw new Error(`GitHub API error: ${response.status}`);
    }

    const release = (await response.json()) as {
      tag_name: string;
      body: string;
      published_at: string;
      assets: Array<{
        name: string;
        browser_download_url: string;
      }>;
      tarball_url: string;
    };

    const releaseVersion = release.tag_name.replace(/^v/, "");
    if (!this.isNewer(releaseVersion, currentVersion)) {
      return null;
    }

    const checksumAsset = release.assets.find(
      (a) => a.name === "SHA256SUMS" || a.name === "checksums.txt"
    );
    let sha256 = "";
    if (checksumAsset) {
      const csResp = await fetch(checksumAsset.browser_download_url);
      if (csResp.ok) {
        const text = await csResp.text();
        const match = text.match(/^([a-f0-9]{64})/m);
        if (match) sha256 = match[1];
      }
    }

    return {
      version: releaseVersion,
      tag: release.tag_name,
      tarballUrl: release.tarball_url,
      sha256,
      releaseNotes: release.body ?? "",
      publishedAt: release.published_at,
    };
  }

  async downloadUpdate(info: UpdateInfo): Promise<string> {
    await this.init();

    const response = await fetch(info.tarballUrl, {
      headers: { Accept: "application/vnd.github+json" },
      redirect: "follow",
    });

    if (!response.ok) {
      throw new Error(`Download failed: ${response.status}`);
    }

    const buffer = Buffer.from(await response.arrayBuffer());

    if (!info.sha256) {
      throw new Error(
        "Update rejected: no SHA256 checksum available. The release must include a SHA256SUMS asset."
      );
    }
    const hash = createHash("sha256").update(buffer).digest("hex");
    if (hash !== info.sha256) {
      throw new Error(
        `Checksum mismatch: expected ${info.sha256}, got ${hash}`
      );
    }

    const tarPath = join(this.updatesDir, `${info.version}.tar.gz`);
    await writeFile(tarPath, buffer);
    return tarPath;
  }

  async applyUpdate(
    tarPath: string,
    installDir: string,
    currentVersion: string
  ): Promise<void> {
    // backup current version. Skip node_modules/.git and our own state dirs:
    // node_modules is regenerable and copying it can be hundreds of MB, which
    // would make an in-place update hang; rollback reinstalls deps anyway.
    const backupPath = join(this.backupDir, `${currentVersion}-${Date.now()}`);
    await mkdir(backupPath, { recursive: true });
    await this.copyDirectory(installDir, backupPath, new Set(["node_modules", ".git", "backups", "updates"]));

    // extract update
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

    // apply extracted files over install dir
    await this.copyDirectory(extractDir, installDir);

    // record in history
    const newVersion = tarPath.match(/([^/\\]+)\.tar\.gz$/)?.[1] ?? "unknown";
    await this.addHistoryEntry({
      version: newVersion,
      appliedAt: new Date().toISOString(),
      status: "applied",
      previousVersion: currentVersion,
    });

    // clean up extract dir
    await rm(extractDir, { recursive: true, force: true });
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

  private isNewer(candidate: string, current: string): boolean {
    const parseParts = (v: string) => v.split(".").map((n) => parseInt(n, 10) || 0);
    const a = parseParts(candidate);
    const b = parseParts(current);
    const len = Math.max(a.length, b.length);
    for (let i = 0; i < len; i++) {
      const av = a[i] ?? 0;
      const bv = b[i] ?? 0;
      if (av > bv) return true;
      if (av < bv) return false;
    }
    return false;
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

  private async copyDirectory(src: string, dest: string, skip?: Set<string>): Promise<void> {
    const { readdir } = await import("node:fs/promises");
    await mkdir(dest, { recursive: true });
    const entries = await readdir(src, { withFileTypes: true });
    for (const entry of entries) {
      if (skip && skip.has(entry.name)) continue;
      const srcPath = join(src, entry.name);
      const destPath = join(dest, entry.name);
      if (entry.isDirectory()) {
        await this.copyDirectory(srcPath, destPath, skip);
      } else {
        await copyFile(srcPath, destPath);
      }
    }
  }
}
