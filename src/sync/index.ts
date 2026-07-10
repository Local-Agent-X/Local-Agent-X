import { execFile } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";

import { createLogger } from "../logger.js";
import { gitCredentialArgs, gitCredentialEnv } from "./git-auth.js";
import { DEFAULT_CONFIG, type SyncConfig } from "./constants.js";
import { resolveConflicts } from "./conflict-resolver.js";
import { copyFromSync } from "./pull-files.js";
import { copyToSync } from "./push-files.js";
import { isLocalOnlyMode, LOCAL_ONLY_BLOCK_MESSAGE } from "../local-only-policy.js";

export type { SyncConfig } from "./constants.js";

const logger = createLogger("sync");
const execFileAsync = promisify(execFile);

// Every git child this class spawns runs with a 30s timeout, so a lock file
// older than this cannot belong to a live git we started — it was left by a
// killed process. Younger locks are left alone (an op may be in flight).
const STALE_GIT_LOCK_MS = 60_000;

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

  // Per-invocation git auth: the remote URL stays BARE (no secret in
  // .git/config) and the vault token is read by an inline credential helper
  // from the env — never argv, never disk. The empty credential.helper also
  // resets the host helper chain (GCM/keychain) so only the vault authorizes;
  // without that, host-cached creds the vault never approved would serve,
  // breaking the "encrypted vault is source of truth" promise. A missing token
  // means no helper at all → git can't auth → callers refuse to sync.
  private git = async (...args: string[]): Promise<string> => {
    const token = this.getToken();
    try {
      const { stdout } = await execFileAsync("git", [...gitCredentialArgs(token), ...args], {
        cwd: this.syncDir, timeout: 30_000, windowsHide: true,
        env: { ...process.env, ...gitCredentialEnv(token) },
      });
      return stdout.trim();
    } catch (e) {
      throw new Error((e as { stderr?: string; message: string }).stderr || (e as Error).message);
    }
  };

  async init(): Promise<boolean> {
    if (!this.config.enabled || !this.config.repoUrl) return false;
    const token = this.getToken();
    if (!token) {
      logger.warn("[sync] no GITHUB_SYNC_TOKEN in vault — sync disabled until token is restored");
      return false;
    }
    // BARE url — auth comes from the env-backed credential helper, not the URL.
    // The set-url below also migrates installs whose .git/config still has the
    // old token-embedded remote: it's overwritten with this bare one.
    const url = this.config.repoUrl;
    if (!existsSync(this.syncDir)) {
      mkdirSync(this.syncDir, { recursive: true });
      try {
        await execFileAsync("git", [...gitCredentialArgs(token), "clone", url, this.syncDir], { timeout: 60_000, windowsHide: true, env: { ...process.env, ...gitCredentialEnv(token) } });
      } catch {
        await execFileAsync("git", ["-c", "credential.helper=", "init"], { cwd: this.syncDir, windowsHide: true, env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } });
        await this.git("remote", "add", "origin", url);
      }
    }
    try { await this.git("remote", "set-url", "origin", url); } catch {}
    await this.recoverStrandedGitState();
    return true;
  }

  // A git child killed mid-flight (e.g. a hard app exit during a heartbeat
  // pull --rebase) strands .git/index.lock and rebase-merge/ — and nothing
  // ever cleaned them: the next pull --rebase failed on the lock, the
  // rebase --abort in push()'s catch failed on the SAME lock, the
  // --no-rebase fallback failed too, and every future sync was wedged until
  // the user hand-deleted the lock. Heal here so every push/pull (both go
  // through init) starts from an operable repo.
  private async recoverStrandedGitState(): Promise<void> {
    const gitDir = join(this.syncDir, ".git");
    if (!existsSync(gitDir)) return;
    const lock = join(gitDir, "index.lock");
    if (existsSync(lock)) {
      try {
        if (Date.now() - statSync(lock).mtimeMs > STALE_GIT_LOCK_MS) {
          rmSync(lock, { force: true });
          logger.warn("[sync] removed stale .git/index.lock left by a killed git process");
        }
      } catch { /* lock vanished between stat and rm — already healed */ }
    }
    // Stranded rebase: abort restores the pre-rebase branch. If abort itself
    // fails (rebase state dir is corrupt/partial), remove the state dirs so
    // git stops refusing every operation with "a rebase is in progress".
    const rebaseDirs = [join(gitDir, "rebase-merge"), join(gitDir, "rebase-apply")];
    if (rebaseDirs.some(d => existsSync(d))) {
      try {
        await this.git("rebase", "--abort");
        logger.warn("[sync] aborted a stranded rebase left by a killed git process");
      } catch {
        for (const d of rebaseDirs) rmSync(d, { recursive: true, force: true });
        logger.warn("[sync] removed corrupt stranded rebase state (.git/rebase-*)");
      }
    }
  }

  async push(): Promise<{ success: boolean; message: string }> {
    if (isLocalOnlyMode()) return { success: false, message: LOCAL_ONLY_BLOCK_MESSAGE };
    if (!this.config.enabled || this.isSyncing) return { success: false, message: "Sync disabled or already running" };
    this.isSyncing = true;
    try {
      if (!await this.init()) { this.isSyncing = false; return { success: false, message: "Sync token missing from vault — add GITHUB_SYNC_TOKEN in Secrets, or re-paste your token in Settings → Sync." }; }
      await copyToSync(this.dataDir, this.syncDir, this.config);
      await this.git("add", "-A");
      let porcelain = "";
      try { porcelain = await this.git("status", "--porcelain"); } catch {}
      // Commits from a prior cycle whose push failed (offline / rejected) stay
      // local — HEAD ahead of origin with a clean working tree. A clean tree
      // alone is NOT "nothing to sync": those commits must still be flushed, or
      // they strand forever (every later cycle sees a clean tree and bails,
      // while the heartbeat's pull keeps the "last synced" clock looking fresh).
      let ahead = false;
      try { ahead = (await this.git("rev-list", "--count", "origin/main..HEAD")) !== "0"; } catch {}
      if (!porcelain && !ahead) { this.lastSyncTime = Date.now(); this.isSyncing = false; return { success: true, message: "Nothing to sync" }; }

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

      // Only commit when the working tree actually changed; a clean tree that
      // reached here is the ahead-of-origin flush path (commits already exist).
      if (porcelain) {
        const hostname = (await execFileAsync("hostname", [], { windowsHide: true })).stdout.trim();
        await this.git("commit", "-m", `sync from ${hostname} at ${new Date().toISOString()}`);
      }

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
    if (isLocalOnlyMode()) return { success: false, message: LOCAL_ONLY_BLOCK_MESSAGE };
    if (!this.config.enabled || this.isSyncing) return { success: false, message: "Sync disabled or already running" };
    this.isSyncing = true;
    try {
      if (!await this.init()) { this.isSyncing = false; return { success: false, message: "Sync token missing from vault — add GITHUB_SYNC_TOKEN in Secrets, or re-paste your token in Settings → Sync." }; }
      try { await this.git("fetch", "origin", "main"); } catch { this.isSyncing = false; return { success: false, message: "Could not reach remote" }; }
      let hasChanges = true;
      try { if (!await this.git("diff", "HEAD", "origin/main", "--stat")) hasChanges = false; } catch {}
      if (hasChanges) { try { await this.git("pull", "--no-rebase", "origin", "main"); } catch { await resolveConflicts(this.syncDir, this.git); } }
      await copyFromSync(this.dataDir, this.syncDir, this.config);
      // Deliberately NOT stamping lastSyncTime here. "Last synced" must mean
      // "local state reached the remote" — only push() (success or genuinely
      // up-to-date) sets it. Stamping on every pull made the heartbeat's
      // inbound half keep the clock fresh while pushes silently failed,
      // showing "synced 14m ago" with no commit on the remote for a week.
      return { success: true, message: hasChanges ? "Downloaded latest" : "Synced local files" };
    } catch (e) {
      return { success: false, message: (e as Error).message };
    } finally { this.isSyncing = false; }
  }

  startHeartbeat(): void {
    if (isLocalOnlyMode()) return;
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
    if (!isLocalOnlyMode() && this.config.enabled && this.config.interval === "after_chat") this.push().catch(() => {});
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
