import { execFile } from "node:child_process";
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, statSync, unlinkSync, rmSync } from "node:fs";
import { join, resolve, relative, extname } from "node:path";
import { promisify } from "node:util";

import { createLogger } from "./logger.js";
const logger = createLogger("sync");

const execFileAsync = promisify(execFile);

export interface SyncConfig {
  enabled: boolean;
  repoUrl: string;
  tokenSecretName: string;
  interval: "after_chat" | "2min" | "5min" | "15min" | "manual";
  syncSessions: boolean;
  syncWorkspace: boolean;
  syncCronJobs: boolean;
  autoDownload: boolean;
}

const DEFAULT_CONFIG: SyncConfig = {
  enabled: false, repoUrl: "", tokenSecretName: "GITHUB_SYNC_TOKEN",
  interval: "after_chat", syncSessions: true, syncWorkspace: false, syncCronJobs: false, autoDownload: true,
};

const SYNC_EXTENSIONS = new Set([
  ".html", ".css", ".js", ".ts", ".tsx", ".jsx", ".json", ".md", ".txt",
  ".yaml", ".yml", ".toml", ".svg", ".env.example", ".py", ".sh", ".bat",
  ".sql", ".graphql", ".png", ".jpg", ".jpeg", ".gif", ".webp", ".ico",
  ".bmp", ".mp4", ".webm", ".mov", ".mp3", ".wav", ".ogg", ".pdf", ".csv",
]);
const SKIP_DIRS = new Set([
  "node_modules", ".next", "dist", "build", ".cache", "__pycache__",
  ".git", ".venv", "venv", "sd-server", "models", "checkpoints", "weights",
]);
const MAX_FILE_SIZE = 10_000_000;

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

  private async git(...args: string[]): Promise<string> {
    try {
      const { stdout } = await execFileAsync("git", args, {
        cwd: this.syncDir, timeout: 30_000, windowsHide: true,
        env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_ASKPASS: "" },
      });
      return stdout.trim();
    } catch (e) {
      throw new Error((e as { stderr?: string; message: string }).stderr || (e as Error).message);
    }
  }

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

  // ── Push direction: local → sync repo (with deletion propagation) ──

  private copyToSync(): void {
    const memDir = join(this.dataDir, "memory");
    const syncMemDir = join(this.syncDir, "memory");
    if (!existsSync(syncMemDir)) mkdirSync(syncMemDir, { recursive: true });

    const localMemFiles = new Set<string>();
    if (existsSync(memDir)) {
      for (const f of readdirSync(memDir)) {
        if (f.endsWith(".md")) {
          localMemFiles.add(f);
          writeFileSync(join(syncMemDir, f), readFileSync(join(memDir, f), "utf-8"), "utf-8");
        }
      }
    }
    // Delete from sync repo if deleted locally
    for (const f of readdirSync(syncMemDir)) {
      if (f.endsWith(".md") && !localMemFiles.has(f)) unlinkSync(join(syncMemDir, f));
    }

    const policyPath = join(this.dataDir, "tool-policy.json");
    if (existsSync(policyPath)) writeFileSync(join(this.syncDir, "tool-policy.json"), readFileSync(policyPath, "utf-8"));

    const configPath = join(this.dataDir, "config.json");
    if (existsSync(configPath)) {
      try {
        const cfg = JSON.parse(readFileSync(configPath, "utf-8"));
        delete cfg.authToken; delete cfg.openaiApiKey;
        writeFileSync(join(this.syncDir, "config-sanitized.json"), JSON.stringify(cfg, null, 2));
      } catch {}
    }

    if (this.config.syncSessions) {
      const sessDir = join(this.dataDir, "sessions");
      const syncSessDir = join(this.syncDir, "sessions");
      if (!existsSync(syncSessDir)) mkdirSync(syncSessDir, { recursive: true });
      if (existsSync(sessDir)) {
        for (const f of readdirSync(sessDir)) {
          if (f.endsWith(".json")) writeFileSync(join(syncSessDir, f), readFileSync(join(sessDir, f), "utf-8"));
        }
      }
    }

    if (this.config.syncWorkspace) {
      const workspace = resolve("workspace");
      if (existsSync(workspace)) this.mirrorDir(workspace, join(this.syncDir, "workspace"));
    }

    if (this.config.syncCronJobs) {
      const cronDir = join(this.dataDir, "cron");
      const syncCronDir = join(this.syncDir, "cron");
      if (!existsSync(syncCronDir)) mkdirSync(syncCronDir, { recursive: true });
      if (existsSync(cronDir)) {
        for (const f of readdirSync(cronDir)) {
          if (f.endsWith(".json")) writeFileSync(join(syncCronDir, f), readFileSync(join(cronDir, f), "utf-8"));
        }
      }
    }
  }

  /** Mirror src → dest: copies files, deletes dest entries not in src */
  private mirrorDir(src: string, dest: string): void {
    if (!existsSync(dest)) mkdirSync(dest, { recursive: true });
    const srcEntries = new Set<string>();

    for (const entry of readdirSync(src)) {
      const srcPath = join(src, entry);
      const stat = statSync(srcPath);
      if (stat.isDirectory()) {
        if (!SKIP_DIRS.has(entry)) { srcEntries.add(entry); this.mirrorDir(srcPath, join(dest, entry)); }
      } else if (stat.isFile()) {
        const ext = extname(entry).toLowerCase();
        const isDoc = /^(PROJECT|CHANGELOG|TODO|README)\.md$/i.test(entry);
        if ((SYNC_EXTENSIONS.has(ext) || isDoc) && stat.size <= MAX_FILE_SIZE) {
          srcEntries.add(entry);
          writeFileSync(join(dest, entry), readFileSync(srcPath));
        }
      }
    }
    // Remove entries deleted from source
    for (const entry of readdirSync(dest)) {
      if (!srcEntries.has(entry)) {
        const p = join(dest, entry);
        if (statSync(p).isDirectory()) rmSync(p, { recursive: true, force: true }); else unlinkSync(p);
      }
    }
  }

  // ── Pull direction: sync repo → local (with deletion propagation) ──

  private copyFromSync(): void {
    const syncMemDir = join(this.syncDir, "memory");
    const memDir = join(this.dataDir, "memory");
    if (!existsSync(memDir)) mkdirSync(memDir, { recursive: true });

    const remoteMemFiles = new Set<string>();
    if (existsSync(syncMemDir)) {
      let checkTaint: ((s: string) => { safe: boolean; reason?: string }) | null = null;
      try { checkTaint = require("./sanitize.js").checkMemoryTaint; } catch {}

      for (const f of readdirSync(syncMemDir)) {
        if (!f.endsWith(".md")) continue;
        remoteMemFiles.add(f);
        const syncContent = readFileSync(join(syncMemDir, f), "utf-8");
        if (checkTaint) {
          const t = checkTaint(syncContent);
          if (!t.safe) { logger.warn(`[sync] Rejected ${f}: ${t.reason}`); continue; }
        }
        const localPath = join(memDir, f);
        if (existsSync(localPath)) {
          writeFileSync(localPath, this.unionMerge(readFileSync(localPath, "utf-8"), syncContent), "utf-8");
        } else {
          writeFileSync(localPath, syncContent, "utf-8");
        }
      }
    }
    // Delete local memory files removed from sync repo
    for (const f of readdirSync(memDir)) {
      if (f.endsWith(".md") && !remoteMemFiles.has(f)) {
        logger.info(`[sync] Deleting ${f} (removed from remote)`);
        unlinkSync(join(memDir, f));
      }
    }

    // Tool policy: merge remote rules into local (don't overwrite — local may have new rules)
    const syncPolicy = join(this.syncDir, "tool-policy.json");
    if (existsSync(syncPolicy)) {
      try {
        const remote = JSON.parse(readFileSync(syncPolicy, "utf-8"));
        const localPath = join(this.dataDir, "tool-policy.json");
        if (existsSync(localPath)) {
          const local = JSON.parse(readFileSync(localPath, "utf-8"));
          const localIds = new Set((local.rules || []).map((r: any) => r.id));
          for (const rule of (remote.rules || [])) {
            if (!localIds.has(rule.id)) local.rules.push(rule);
          }
          writeFileSync(localPath, JSON.stringify(local, null, 2), "utf-8");
        } else {
          writeFileSync(localPath, readFileSync(syncPolicy, "utf-8"));
        }
      } catch { writeFileSync(join(this.dataDir, "tool-policy.json"), readFileSync(syncPolicy, "utf-8")); }
    }

    if (this.config.syncSessions) {
      const syncSessDir = join(this.syncDir, "sessions");
      const sessDir = join(this.dataDir, "sessions");
      if (!existsSync(sessDir)) mkdirSync(sessDir, { recursive: true });
      if (existsSync(syncSessDir)) {
        for (const f of readdirSync(syncSessDir)) {
          if (f.endsWith(".json") && !existsSync(join(sessDir, f))) writeFileSync(join(sessDir, f), readFileSync(join(syncSessDir, f), "utf-8"));
        }
      }
    }

    if (this.config.syncWorkspace) {
      const syncWs = join(this.syncDir, "workspace");
      const ws = resolve("workspace");
      if (existsSync(syncWs)) { if (!existsSync(ws)) mkdirSync(ws, { recursive: true }); this.pullDir(syncWs, ws); }
    }

    if (this.config.syncCronJobs) {
      const syncCronDir = join(this.syncDir, "cron");
      const cronDir = join(this.dataDir, "cron");
      if (!existsSync(cronDir)) mkdirSync(cronDir, { recursive: true });
      if (existsSync(syncCronDir)) {
        for (const f of readdirSync(syncCronDir)) {
          if (f.endsWith(".json")) writeFileSync(join(cronDir, f), readFileSync(join(syncCronDir, f), "utf-8"));
        }
      }
    }
  }

  /** Pull from sync → local. Propagates deletions. */
  private pullDir(src: string, dest: string): void {
    if (!existsSync(dest)) mkdirSync(dest, { recursive: true });
    const remoteEntries = new Set<string>();
    for (const entry of readdirSync(src)) {
      remoteEntries.add(entry);
      const srcPath = join(src, entry);
      const destPath = join(dest, entry);
      const stat = statSync(srcPath);
      if (stat.isDirectory()) {
        this.pullDir(srcPath, destPath);
      } else if (stat.isFile()) {
        if (!existsSync(destPath) || statSync(destPath).mtimeMs < stat.mtimeMs) writeFileSync(destPath, readFileSync(srcPath));
      }
    }
    // Delete local entries removed from sync repo
    for (const entry of readdirSync(dest)) {
      if (!remoteEntries.has(entry)) {
        const p = join(dest, entry);
        logger.info(`[sync] Deleting ${relative(resolve("workspace"), p)} (removed from remote)`);
        if (statSync(p).isDirectory()) rmSync(p, { recursive: true, force: true }); else unlinkSync(p);
      }
    }
  }

  private unionMerge(local: string, remote: string): string {
    const seen = new Set<string>();
    const merged: string[] = [];
    for (const line of local.split("\n").map(l => l.trim()).filter(Boolean)) {
      if (!seen.has(line)) { seen.add(line); merged.push(line); }
    }
    for (const line of remote.split("\n").map(l => l.trim()).filter(Boolean)) {
      if (!seen.has(line)) { seen.add(line); merged.push(line); }
    }
    return merged.join("\n") + "\n";
  }

  // ── Push / Pull / Heartbeat ──

  async push(): Promise<{ success: boolean; message: string }> {
    if (!this.config.enabled || this.isSyncing) return { success: false, message: "Sync disabled or already running" };
    this.isSyncing = true;
    try {
      await this.init();
      this.copyToSync();
      await this.git("add", "-A");
      try { const s = await this.git("status", "--porcelain"); if (!s) { this.isSyncing = false; return { success: true, message: "Nothing to sync" }; } } catch {}
      const hostname = (await execFileAsync("hostname", [], { windowsHide: true })).stdout.trim();
      await this.git("commit", "-m", `sync from ${hostname} at ${new Date().toISOString()}`);
      try { await this.git("pull", "--rebase", "origin", "main"); } catch {
        try { await this.git("rebase", "--abort"); } catch {}
        try { await this.git("pull", "--no-rebase", "origin", "main"); await this.resolveConflicts(); } catch {}
      }
      await this.git("push", "-u", "origin", "HEAD:main");
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
      if (hasChanges) { try { await this.git("pull", "--no-rebase", "origin", "main"); } catch { await this.resolveConflicts(); } }
      this.copyFromSync();
      this.lastSyncTime = Date.now();
      return { success: true, message: hasChanges ? "Downloaded latest" : "Synced local files" };
    } catch (e) {
      return { success: false, message: (e as Error).message };
    } finally { this.isSyncing = false; }
  }

  private async resolveConflicts(): Promise<void> {
    try {
      const status = await this.git("status", "--porcelain");
      const conflicted = status.split("\n").filter(l => l.startsWith("UU ") || l.startsWith("AA "));
      for (const line of conflicted) {
        const file = line.slice(3).trim();
        if (file.endsWith(".md")) {
          const fullPath = join(this.syncDir, file);
          if (existsSync(fullPath)) {
            const cleaned = readFileSync(fullPath, "utf-8").replace(/<<<<<<< HEAD\n/g, "").replace(/=======\n/g, "").replace(/>>>>>>> .*\n/g, "");
            const lines = Array.from(new Set(cleaned.split("\n").map(l => l.trim()).filter(Boolean)));
            writeFileSync(fullPath, lines.join("\n") + "\n");
          }
        }
        await this.git("add", file);
      }
      if (conflicted.length > 0) await this.git("commit", "-m", "auto-merge: union merge resolved conflicts");
    } catch {}
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

  getStatus() {
    return {
      enabled: this.config.enabled, lastSync: this.lastSyncTime, isSyncing: this.isSyncing,
      repoUrl: this.config.repoUrl, interval: this.config.interval,
      autoDownload: this.config.autoDownload, syncSessions: this.config.syncSessions,
    };
  }
}
