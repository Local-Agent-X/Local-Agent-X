import { execFile } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";

import { createLogger } from "./logger.js";
import { DEFAULT_CONFIG, type SyncConfig } from "./sync/constants.js";
import { resolveConflicts } from "./sync/conflict-resolver.js";
import { copyFromSync } from "./sync/pull-files.js";
import { copyToSync } from "./sync/push-files.js";

export type { SyncConfig } from "./sync/constants.js";

const logger = createLogger("sync");
const execFileAsync = promisify(execFile);

export class AgentSync {
  private config: SyncConfig;
  private dataDir: string;
  private syncDir: string;
  private configPath: string;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private isSyncing = false;
  private lastSyncTime = 0;
  private getToken: () => string | undefined;

  constructor(dataDir: string, getToken: () => string | undefined) {
    this.dataDir = dataDir;
    this.syncDir = join(dataDir, "sync-repo");
    this.configPath = join(dataDir, "sync-config.json");
    this.getToken = getToken;
    this.config = this.loadConfig();
  }

  private loadConfig(): SyncConfig {
    if (existsSync(this.configPath)) {
      try { return { ...DEFAULT_CONFIG, ...JSON.parse(readFileSync(this.configPath, "utf-8")) }; } catch {}
    }
    return { ...DEFAULT_CONFIG };
  }

  saveConfig(config: Partial<SyncConfig>): void {
    this.config = { ...this.config, ...config };
    writeFileSync(this.configPath, JSON.stringify(this.config, null, 2), { encoding: "utf-8", mode: 0o600 });
  }

  getConfig(): SyncConfig { return { ...this.config }; }

  private getAuthUrl(): string {
    const token = this.getToken();
    if (!token || !this.config.repoUrl) return this.config.repoUrl;
    try {
      const url = new URL(this.config.repoUrl);
      url.username = "x-access-token";
      url.password = token;
      return url.toString();
    } catch { return this.config.repoUrl; }
  }

  private git = async (...args: string[]): Promise<string> => {
    try {
      const { stdout } = await execFileAsync("git", args, {
        cwd: this.syncDir, timeout: 30_000, windowsHide: true,
        env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_ASKPASS: "" },
      });
      return stdout.trim();
    } catch (e) {
      throw new Error((e as { stderr?: string; message: string }).stderr || (e as Error).message);
    }
  };

  async init(): Promise<boolean> {
    if (!this.config.enabled || !this.config.repoUrl) return false;
    if (!existsSync(this.syncDir)) {
      mkdirSync(this.syncDir, { recursive: true });
      try {
        const gitEnv = { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_ASKPASS: "" };
        await execFileAsync("git", ["clone", this.getAuthUrl(), this.syncDir], { timeout: 60_000, windowsHide: true, env: gitEnv });
      } catch {
        await execFileAsync("git", ["init"], { cwd: this.syncDir, windowsHide: true, env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } });
        await this.git("remote", "add", "origin", this.getAuthUrl());
      }
    }
    try { await this.git("remote", "set-url", "origin", this.getAuthUrl()); } catch {}
    return true;
  }

  async push(): Promise<{ success: boolean; message: string }> {
    if (!this.config.enabled || this.isSyncing) return { success: false, message: "Sync disabled or already running" };
    this.isSyncing = true;
    try {
      await this.init();
      copyToSync(this.dataDir, this.syncDir, this.config);
      await this.git("add", "-A");
      let porcelain = "";
      try { porcelain = await this.git("status", "--porcelain"); } catch {}
      if (!porcelain) { this.isSyncing = false; return { success: true, message: "Nothing to sync" }; }

      // Mass-deletion circuit breaker. Live failure (2026-05-05): a sync
      // push from this machine deleted 21 workspace apps belonging to other
      // machines, despite the additive-only mirror + tombstone system. Root
      // cause unconfirmed (likely stale local sync-repo + rebase artifact),
      // but the FIX is defense-in-depth: refuse any push whose workspace/apps
      // mass-deletes top-level apps that aren't paired with explicit
      // tombstones. Forces the user to investigate before destructive sync
      // changes propagate. Recovery from origin is one git checkout; an
      // unintended push is permanent and propagates everywhere on next pull.
      const deletedAppDirs = new Set<string>();
      const tombstonedNames = new Set<string>();
      for (const line of porcelain.split("\n")) {
        const status = line.slice(0, 2);
        const path = line.slice(3).trim();
        if (!path) continue;
        if (status.includes("D")) {
          const m = path.match(/^workspace\/apps\/([^/]+)\//);
          if (m) deletedAppDirs.add(m[1]);
        }
        if (status.includes("A") || status.includes("?")) {
          const m = path.match(/^\.tombstones\/([^/]+)\.json$/);
          if (m) tombstonedNames.add(m[1]);
        }
      }
      const unauthorizedDeletes = [...deletedAppDirs].filter(name => !tombstonedNames.has(name));
      const ABORT_THRESHOLD = 3;
      if (unauthorizedDeletes.length >= ABORT_THRESHOLD) {
        // Don't auto-reset — leave the staged state so the user can inspect
        // what was about to happen (`git status` / `git diff --cached` in
        // ~/.lax/sync-repo). Manual recovery: either `git reset HEAD` and
        // `git checkout -- .` to discard, or wipe and re-clone, then sync
        // again.
        const list = unauthorizedDeletes.slice(0, 10).join(", ") + (unauthorizedDeletes.length > 10 ? `, …+${unauthorizedDeletes.length - 10} more` : "");
        const msg = `[sync] ABORTED: push would mass-delete ${unauthorizedDeletes.length} workspace apps with no matching tombstones (${list}). Likely a stale local sync-repo clone. Inspect ~/.lax/sync-repo (git status / git diff --cached), then manually reconcile (wipe and re-clone, or git pull origin main) before retrying.`;
        logger.error(msg);
        this.isSyncing = false;
        return { success: false, message: msg };
      }

      const hostname = (await execFileAsync("hostname", [], { windowsHide: true })).stdout.trim();
      await this.git("commit", "-m", `sync from ${hostname} at ${new Date().toISOString()}`);

      // When another machine has pushed since our last sync, our local
      // commit is on a divergent branch and the final push will reject
      // with non-fast-forward. Try rebase first, then merge fallback.
      // Surface why each fallback failed instead of swallowing — the
      // old code caught both rebase and merge silently, then ran push
      // anyway and bubbled up only the cryptic "Updates were rejected"
      // git push error. The user's real problem (rebase couldn't apply
      // because of conflicting writes, network blip on pull, etc.) was
      // hidden until they read the server log.
      let rebaseErr: Error | null = null;
      let mergeErr: Error | null = null;
      try {
        await this.git("pull", "--rebase", "origin", "main");
      } catch (e) {
        rebaseErr = e as Error;
        try { await this.git("rebase", "--abort"); } catch { /* nothing to abort */ }
        try {
          await this.git("pull", "--no-rebase", "origin", "main");
          await resolveConflicts(this.syncDir, this.git);
        } catch (e2) {
          mergeErr = e2 as Error;
        }
      }
      try {
        await this.git("push", "-u", "origin", "HEAD:main");
      } catch (pushErr) {
        // Push failed — almost always non-fast-forward when the rebase
        // and merge fallback above also failed. Build a single message
        // that names the real cause, not the downstream symptom.
        const reasons: string[] = [];
        if (rebaseErr) reasons.push(`rebase failed: ${rebaseErr.message.split("\n")[0].slice(0, 200)}`);
        if (mergeErr) reasons.push(`merge fallback failed: ${mergeErr.message.split("\n")[0].slice(0, 200)}`);
        const detail = reasons.length > 0 ? ` (root cause: ${reasons.join("; ")})` : "";
        const finalMsg = `[sync] push rejected — remote has commits this machine doesn't have${detail}. Hit Force Pull to integrate the remote state, then sync again. Original git error: ${(pushErr as Error).message.split("\n")[0]}`;
        logger.error(finalMsg);
        this.isSyncing = false;
        return { success: false, message: finalMsg };
      }
      this.lastSyncTime = Date.now();
      return { success: true, message: "Synced" };
    } catch (e) {
      return { success: false, message: (e as Error).message };
    } finally { this.isSyncing = false; }
  }

  async pull(): Promise<{ success: boolean; message: string }> {
    if (!this.config.enabled || this.isSyncing) return { success: false, message: "Sync disabled or already running" };
    this.isSyncing = true;
    try {
      await this.init();
      try { await this.git("fetch", "origin", "main"); } catch { this.isSyncing = false; return { success: false, message: "Could not reach remote" }; }
      let hasChanges = true;
      try { if (!await this.git("diff", "HEAD", "origin/main", "--stat")) hasChanges = false; } catch {}
      if (hasChanges) { try { await this.git("pull", "--no-rebase", "origin", "main"); } catch { await resolveConflicts(this.syncDir, this.git); } }
      await copyFromSync(this.dataDir, this.syncDir, this.config);
      this.lastSyncTime = Date.now();
      return { success: true, message: hasChanges ? "Downloaded latest" : "Synced local files" };
    } catch (e) {
      return { success: false, message: (e as Error).message };
    } finally { this.isSyncing = false; }
  }

  startHeartbeat(): void {
    if (!this.config.enabled || this.config.interval === "manual") return;
    const ms = { after_chat: 0, "2min": 120_000, "5min": 300_000, "15min": 900_000, manual: 0 }[this.config.interval];
    if (ms > 0) {
      this.heartbeatTimer = setInterval(async () => { await this.pull(); await this.push(); }, ms);
    }
  }

  stopHeartbeat(): void {
    if (this.heartbeatTimer) { clearInterval(this.heartbeatTimer); this.heartbeatTimer = null; }
  }

  async onChatEnd(): Promise<void> {
    if (this.config.enabled && this.config.interval === "after_chat") this.push().catch(() => {});
  }

  private pushDebounceTimer: ReturnType<typeof setTimeout> | null = null;
  private lastChangeReasons: string[] = [];

  /**
   * Queue a debounced push triggered by a state mutation (unpin, delete
   * project, delete folder, etc.). Without this, deletes only propagate
   * on the heartbeat interval — a 15-min window where another machine
   * pulling sees stale data. The debounce coalesces a burst of mutations
   * (e.g. user unpins 5 things in a row) into a single push.
   *
   * Quiet period: 5s. Each new call resets the timer. If sync is
   * disabled or already running, this becomes a no-op.
   */
  notifyChange(reason: string): void {
    if (!this.config.enabled) return;
    this.lastChangeReasons.push(reason);
    if (this.pushDebounceTimer) clearTimeout(this.pushDebounceTimer);
    this.pushDebounceTimer = setTimeout(() => {
      this.pushDebounceTimer = null;
      const reasons = this.lastChangeReasons.splice(0).join(", ");
      logger.info(`[sync] push-on-change firing: ${reasons}`);
      this.push().catch((e) => logger.warn(`[sync] push-on-change failed: ${(e as Error).message}`));
    }, 5_000);
  }

  getStatus() {
    // Include EVERY persisted flag so the settings UI can populate its
    // toggles correctly. Missing fields default to off in the UI, and
    // the next saveSyncConfig sends them back as `false`, silently
    // overwriting the on-disk `true` value. That was the bug behind
    // "workspace sync flips off after every server restart": getStatus
    // never returned syncWorkspace / syncCronJobs, so the toggles came
    // up off, the user (or auto-save) wrote them off, and the disk
    // state never recovered.
    return {
      enabled: this.config.enabled, lastSync: this.lastSyncTime, isSyncing: this.isSyncing,
      repoUrl: this.config.repoUrl, interval: this.config.interval,
      autoDownload: this.config.autoDownload, syncSessions: this.config.syncSessions,
      syncWorkspace: this.config.syncWorkspace, syncCronJobs: this.config.syncCronJobs,
      syncMissions: this.config.syncMissions, syncProtocols: this.config.syncProtocols,
    };
  }
}
