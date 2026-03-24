import { execFile, spawn } from "node:child_process";
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, statSync } from "node:fs";
import { join, resolve, relative, extname } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/**
 * Agent Sync — Git-based memory synchronization across machines.
 *
 * Syncs the agent's "soul" (memory, identity, config) to a private GitHub repo.
 * Background operations — user never sees terminals or popups.
 *
 * Safe sync list:  memory/*.md, tool-policy.json, config.json (sanitized)
 * Never synced:    secrets.enc, secrets.salt, master.dpapi, tokens.json, auth.json, audit/
 *
 * Merge strategy:
 * - .md files: union merge (keep all unique lines from both versions)
 * - .json files: last-write-wins
 * - sessions/: per-file, no conflict (unique IDs)
 */

export interface SyncConfig {
  enabled: boolean;
  repoUrl: string;          // e.g. https://github.com/user/agent-memory.git
  tokenSecretName: string;  // Name in secrets vault (e.g. GITHUB_SYNC_TOKEN)
  interval: "after_chat" | "2min" | "5min" | "15min" | "manual";
  syncSessions: boolean;    // Optional: sync session history
  syncWorkspace: boolean;   // Optional: sync workspace/apps (PROJECT.md, source files)
  autoDownload: boolean;    // Pull on startup
}

const DEFAULT_CONFIG: SyncConfig = {
  enabled: false,
  repoUrl: "",
  tokenSecretName: "GITHUB_SYNC_TOKEN",
  interval: "after_chat",
  syncSessions: false,
  syncWorkspace: false,
  autoDownload: true,
};

// Files that should NEVER be synced (security risk)
const NEVER_SYNC = new Set([
  "secrets.enc", "secrets.salt", "master.dpapi",
  "tokens.json", "auth.json", "config.json",
  "memory.db", "memory.db-wal", "memory.db-shm",
]);

const NEVER_SYNC_DIRS = new Set(["audit", "voice-tmp", "chrome-profile"]);

export class AgentSync {
  private config: SyncConfig;
  private dataDir: string;
  private syncDir: string;      // Local git repo clone
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

  // ── Config ──

  private loadConfig(): SyncConfig {
    if (existsSync(this.configPath)) {
      try {
        return { ...DEFAULT_CONFIG, ...JSON.parse(readFileSync(this.configPath, "utf-8")) };
      } catch {}
    }
    return { ...DEFAULT_CONFIG };
  }

  saveConfig(config: Partial<SyncConfig>): void {
    this.config = { ...this.config, ...config };
    writeFileSync(this.configPath, JSON.stringify(this.config, null, 2), { encoding: "utf-8", mode: 0o600 });
  }

  getConfig(): SyncConfig { return { ...this.config }; }

  // ── Git helpers (silent, background) ──

  private getAuthUrl(): string {
    const token = this.getToken();
    if (!token || !this.config.repoUrl) return this.config.repoUrl;
    try {
      const url = new URL(this.config.repoUrl);
      url.username = "x-access-token";
      url.password = token;
      return url.toString();
    } catch {
      return this.config.repoUrl;
    }
  }

  private async git(...args: string[]): Promise<string> {
    try {
      const { stdout } = await execFileAsync("git", args, {
        cwd: this.syncDir,
        timeout: 30_000,
        windowsHide: true,
      });
      return stdout.trim();
    } catch (e) {
      const err = e as { stderr?: string; message: string };
      throw new Error(err.stderr || err.message);
    }
  }

  // ── Initialize sync repo ──

  async init(): Promise<boolean> {
    if (!this.config.enabled || !this.config.repoUrl) return false;

    if (!existsSync(this.syncDir)) {
      mkdirSync(this.syncDir, { recursive: true });
      try {
        await execFileAsync("git", ["clone", this.getAuthUrl(), this.syncDir], {
          timeout: 60_000,
          windowsHide: true,
        });
        console.log("[sync] Cloned sync repo");
      } catch {
        // Empty repo — init locally
        await execFileAsync("git", ["init"], { cwd: this.syncDir, windowsHide: true });
        await this.git("remote", "add", "origin", this.getAuthUrl());
        console.log("[sync] Initialized new sync repo");
      }
    }

    // Update remote URL (in case token changed)
    try {
      await this.git("remote", "set-url", "origin", this.getAuthUrl());
    } catch {}

    return true;
  }

  // ── Copy files: data dir → sync repo (respecting safe list) ──

  private copyToSync(): void {
    const memDir = join(this.dataDir, "memory");
    const syncMemDir = join(this.syncDir, "memory");
    if (!existsSync(syncMemDir)) mkdirSync(syncMemDir, { recursive: true });

    // Copy memory .md files
    if (existsSync(memDir)) {
      for (const file of readdirSync(memDir)) {
        if (file.endsWith(".md")) {
          const src = readFileSync(join(memDir, file), "utf-8");
          writeFileSync(join(syncMemDir, file), src, "utf-8");
        }
      }
    }

    // Copy tool policy
    const policyPath = join(this.dataDir, "tool-policy.json");
    if (existsSync(policyPath)) {
      writeFileSync(join(this.syncDir, "tool-policy.json"), readFileSync(policyPath, "utf-8"));
    }

    // Copy sanitized config (strip secrets)
    const configPath = join(this.dataDir, "config.json");
    if (existsSync(configPath)) {
      try {
        const cfg = JSON.parse(readFileSync(configPath, "utf-8"));
        delete cfg.authToken;
        delete cfg.openaiApiKey;
        writeFileSync(join(this.syncDir, "config-sanitized.json"), JSON.stringify(cfg, null, 2));
      } catch {}
    }

    // Optional: copy sessions
    if (this.config.syncSessions) {
      const sessDir = join(this.dataDir, "sessions");
      const syncSessDir = join(this.syncDir, "sessions");
      if (!existsSync(syncSessDir)) mkdirSync(syncSessDir, { recursive: true });
      if (existsSync(sessDir)) {
        for (const file of readdirSync(sessDir)) {
          if (file.endsWith(".json")) {
            writeFileSync(join(syncSessDir, file), readFileSync(join(sessDir, file), "utf-8"));
          }
        }
      }
    }

    // Optional: sync workspace apps (source code, project docs — skip heavy artifacts)
    if (this.config.syncWorkspace) {
      const workspaceApps = resolve("workspace", "apps");
      const syncAppsDir = join(this.syncDir, "workspace-apps");
      if (existsSync(workspaceApps)) {
        this.copyDirFiltered(workspaceApps, syncAppsDir);
      }
    }
  }

  /** Recursively copy a directory, skipping heavy/generated artifacts */
  private copyDirFiltered(src: string, dest: string): void {
    // Skip these directories entirely (heavy, regeneratable)
    const SKIP_DIRS = new Set(["node_modules", ".next", "dist", "build", ".cache", "__pycache__", ".git", ".venv", "venv"]);
    // Only sync these file extensions (source code + project docs)
    const SYNC_EXTENSIONS = new Set([
      ".html", ".css", ".js", ".ts", ".tsx", ".jsx", ".json", ".md",
      ".txt", ".yaml", ".yml", ".toml", ".svg", ".env.example",
      ".py", ".sh", ".bat", ".sql", ".graphql",
    ]);
    const MAX_FILE_SIZE = 500_000; // 500KB max per file

    if (!existsSync(dest)) mkdirSync(dest, { recursive: true });

    for (const entry of readdirSync(src)) {
      const srcPath = join(src, entry);
      const destPath = join(dest, entry);
      const stat = statSync(srcPath);

      if (stat.isDirectory()) {
        if (!SKIP_DIRS.has(entry)) {
          this.copyDirFiltered(srcPath, destPath);
        }
      } else if (stat.isFile()) {
        const ext = extname(entry).toLowerCase();
        // Always sync project docs regardless of extension
        const isProjectDoc = /^(PROJECT|CHANGELOG|TODO|README)\.md$/i.test(entry);
        if ((SYNC_EXTENSIONS.has(ext) || isProjectDoc) && stat.size <= MAX_FILE_SIZE) {
          if (!existsSync(join(dest, ".."))) mkdirSync(join(dest, ".."), { recursive: true });
          writeFileSync(destPath, readFileSync(srcPath));
        }
      }
    }
  }

  // ── Copy files: sync repo → data dir ──

  private copyFromSync(): void {
    const syncMemDir = join(this.syncDir, "memory");
    const memDir = join(this.dataDir, "memory");
    if (!existsSync(memDir)) mkdirSync(memDir, { recursive: true });

    // Copy memory .md files
    if (existsSync(syncMemDir)) {
      for (const file of readdirSync(syncMemDir)) {
        if (file.endsWith(".md")) {
          const syncContent = readFileSync(join(syncMemDir, file), "utf-8");
          const localPath = join(memDir, file);

          if (existsSync(localPath)) {
            // Union merge for .md files
            const localContent = readFileSync(localPath, "utf-8");
            const merged = this.unionMerge(localContent, syncContent);
            writeFileSync(localPath, merged, "utf-8");
          } else {
            writeFileSync(localPath, syncContent, "utf-8");
          }
        }
      }
    }

    // Copy tool policy (last-write-wins)
    const syncPolicy = join(this.syncDir, "tool-policy.json");
    if (existsSync(syncPolicy)) {
      writeFileSync(join(this.dataDir, "tool-policy.json"), readFileSync(syncPolicy, "utf-8"));
    }

    // Optional: copy sessions
    if (this.config.syncSessions) {
      const syncSessDir = join(this.syncDir, "sessions");
      const sessDir = join(this.dataDir, "sessions");
      if (!existsSync(sessDir)) mkdirSync(sessDir, { recursive: true });
      if (existsSync(syncSessDir)) {
        for (const file of readdirSync(syncSessDir)) {
          if (file.endsWith(".json") && !existsSync(join(sessDir, file))) {
            writeFileSync(join(sessDir, file), readFileSync(join(syncSessDir, file), "utf-8"));
          }
        }
      }
    }

    // Optional: pull workspace apps from sync
    if (this.config.syncWorkspace) {
      const syncAppsDir = join(this.syncDir, "workspace-apps");
      const workspaceApps = resolve("workspace", "apps");
      if (existsSync(syncAppsDir)) {
        if (!existsSync(workspaceApps)) mkdirSync(workspaceApps, { recursive: true });
        this.pullDirFiltered(syncAppsDir, workspaceApps);
      }
    }
  }

  /** Pull synced files into workspace (won't overwrite newer local files) */
  private pullDirFiltered(src: string, dest: string): void {
    if (!existsSync(dest)) mkdirSync(dest, { recursive: true });
    for (const entry of readdirSync(src)) {
      const srcPath = join(src, entry);
      const destPath = join(dest, entry);
      const stat = statSync(srcPath);
      if (stat.isDirectory()) {
        this.pullDirFiltered(srcPath, destPath);
      } else if (stat.isFile()) {
        // Only write if local file doesn't exist or is older
        if (!existsSync(destPath) || statSync(destPath).mtimeMs < stat.mtimeMs) {
          writeFileSync(destPath, readFileSync(srcPath));
        }
      }
    }
  }

  // ── Union merge for .md files ──

  private unionMerge(local: string, remote: string): string {
    const localLines = local.split("\n").map(l => l.trim()).filter(Boolean);
    const remoteLines = remote.split("\n").map(l => l.trim()).filter(Boolean);
    const seen = new Set<string>();
    const merged: string[] = [];

    // Keep order from local, then add new lines from remote
    for (const line of localLines) {
      if (!seen.has(line)) { seen.add(line); merged.push(line); }
    }
    for (const line of remoteLines) {
      if (!seen.has(line)) { seen.add(line); merged.push(line); }
    }
    return merged.join("\n") + "\n";
  }

  // ── Push (background, non-blocking) ──

  async push(): Promise<{ success: boolean; message: string }> {
    if (!this.config.enabled || this.isSyncing) return { success: false, message: "Sync disabled or already running" };
    this.isSyncing = true;

    try {
      await this.init();
      this.copyToSync();

      // Stage all changes
      await this.git("add", "-A");

      // Check if there's anything to commit
      try {
        const status = await this.git("status", "--porcelain");
        if (!status) { this.isSyncing = false; return { success: true, message: "Nothing to sync" }; }
      } catch {}

      // Commit
      const hostname = (await execFileAsync("hostname", [], { windowsHide: true })).stdout.trim();
      await this.git("commit", "-m", `sync from ${hostname} at ${new Date().toISOString()}`);

      // Pull + rebase first (handle remote changes)
      try {
        await this.git("pull", "--rebase", "origin", "main");
      } catch {
        // If rebase fails (conflict), abort and try merge
        try { await this.git("rebase", "--abort"); } catch {}
        try {
          await this.git("pull", "--no-rebase", "origin", "main");
          // Auto-resolve any .md conflicts with union merge
          await this.resolveConflicts();
        } catch {}
      }

      // Push
      await this.git("push", "-u", "origin", "HEAD:main");
      this.lastSyncTime = Date.now();
      console.log("[sync] Pushed successfully");
      return { success: true, message: "Synced" };
    } catch (e) {
      console.warn("[sync] Push failed:", (e as Error).message);
      return { success: false, message: (e as Error).message };
    } finally {
      this.isSyncing = false;
    }
  }

  // ── Pull (background, non-blocking) ──

  async pull(): Promise<{ success: boolean; message: string }> {
    if (!this.config.enabled || this.isSyncing) return { success: false, message: "Sync disabled or already running" };
    this.isSyncing = true;

    try {
      await this.init();

      // Fetch latest
      try {
        await this.git("fetch", "origin", "main");
      } catch {
        this.isSyncing = false;
        return { success: false, message: "Could not reach remote" };
      }

      // Check if there are remote changes
      try {
        const diff = await this.git("diff", "HEAD", "origin/main", "--stat");
        if (!diff) { this.isSyncing = false; return { success: true, message: "Already up to date" }; }
      } catch {}

      // Pull
      try {
        await this.git("pull", "--no-rebase", "origin", "main");
      } catch {
        await this.resolveConflicts();
      }

      // Copy from sync repo to data dir (with merge)
      this.copyFromSync();
      this.lastSyncTime = Date.now();
      console.log("[sync] Pulled successfully");
      return { success: true, message: "Downloaded latest" };
    } catch (e) {
      console.warn("[sync] Pull failed:", (e as Error).message);
      return { success: false, message: (e as Error).message };
    } finally {
      this.isSyncing = false;
    }
  }

  // ── Resolve git conflicts via union merge ──

  private async resolveConflicts(): Promise<void> {
    try {
      const status = await this.git("status", "--porcelain");
      const conflicted = status.split("\n").filter(l => l.startsWith("UU ") || l.startsWith("AA "));

      for (const line of conflicted) {
        const file = line.slice(3).trim();
        if (file.endsWith(".md")) {
          // Union merge: get both versions, merge unique lines
          const fullPath = join(this.syncDir, file);
          if (existsSync(fullPath)) {
            const content = readFileSync(fullPath, "utf-8");
            // Remove git conflict markers and merge
            const cleaned = content
              .replace(/<<<<<<< HEAD\n/g, "")
              .replace(/=======\n/g, "")
              .replace(/>>>>>>> .*\n/g, "");
            const lines = [...new Set(cleaned.split("\n").map(l => l.trim()).filter(Boolean))];
            writeFileSync(fullPath, lines.join("\n") + "\n");
          }
        }
        await this.git("add", file);
      }

      if (conflicted.length > 0) {
        await this.git("commit", "-m", "auto-merge: union merge resolved conflicts");
      }
    } catch {}
  }

  // ── Heartbeat: check for remote changes periodically ──

  startHeartbeat(): void {
    if (!this.config.enabled || this.config.interval === "manual") return;

    const ms = {
      after_chat: 0,  // No timer, triggered after each chat
      "2min": 2 * 60_000,
      "5min": 5 * 60_000,
      "15min": 15 * 60_000,
      manual: 0,
    }[this.config.interval];

    if (ms > 0) {
      this.heartbeatTimer = setInterval(async () => {
        // Pull to check for remote changes, then push local changes
        await this.pull();
        await this.push();
      }, ms);
      console.log(`[sync] Heartbeat started: every ${ms / 60000} min`);
    }
  }

  stopHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  // ── After chat: push if configured ──

  async onChatEnd(): Promise<void> {
    if (this.config.enabled && (this.config.interval === "after_chat")) {
      // Run in background — don't block the response
      this.push().catch(() => {});
    }
  }

  // ── Status ──

  getStatus() {
    return {
      enabled: this.config.enabled,
      lastSync: this.lastSyncTime,
      isSyncing: this.isSyncing,
      repoUrl: this.config.repoUrl,
      interval: this.config.interval,
      autoDownload: this.config.autoDownload,
      syncSessions: this.config.syncSessions,
    };
  }
}
