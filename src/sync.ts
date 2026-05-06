import { execFile } from "node:child_process";
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, statSync, unlinkSync, rmSync } from "node:fs";
import { join, resolve, relative, extname, dirname } from "node:path";
import { hostname } from "node:os";
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
  ".html", ".css", ".js", ".ts", ".tsx", ".jsx", ".json", ".jsonl", ".md", ".txt",
  ".yaml", ".yml", ".toml", ".svg", ".env.example", ".py", ".sh", ".bat",
  ".sql", ".graphql", ".png", ".jpg", ".jpeg", ".gif", ".webp", ".ico",
  ".bmp", ".mp4", ".webm", ".mov", ".mp3", ".wav", ".ogg", ".pdf", ".csv",
]);
const SKIP_DIRS = new Set([
  "node_modules", ".next", "dist", "build", ".cache", "__pycache__",
  ".git", ".venv", "venv", "sd-server", "models", "checkpoints", "weights",
]);
const MAX_FILE_SIZE = 10_000_000;

// ── Agent-brain sync surface ─────────────────────────────────────────────
//
// Sync's primary mission is BACKUP + restore. A user wiping their
// machine should be able to recover the same look + feel + content of
// their agent. Cross-machine continuity (move from workstation A to B)
// is the same job. These files are the user-level brain state — moods,
// missions, milestones, history — never machine-specific or sensitive.
//
// `BRAIN_JSON_FILES` are flat JSON files at the root of `dataDir`.
// `BRAIN_DIRS` are mirrored as additive trees (no destructive deletes
// unless the file is removed from src), respecting SYNC_EXTENSIONS.
// `BRAIN_BINARY_FILES` are byte-for-byte copies — currently `memory.db`
// for the SQLite memory store. WAL/SHM sidecars are intentionally NOT
// shipped; SQLite reconstructs them on first read and shipping stale
// sidecars can corrupt the DB.
const BRAIN_JSON_FILES: readonly string[] = [
  "agent-issues.json",
  "agent-projects.json",
  "agent-templates.json",
  "associative-memory.json",
  "calendar.json",
  "consolidation-log.json",
  "correction-history.json",
  "cross-session-data.json",
  "custom-missions.json",
  "mission-schedules.json",
  "emotional-history.json",
  "hooks.json",
  "language-style.json",
  "mcp.json",
  "memory-graph.json",
  "memory-tiers.json",
  "milestones.json",
  "orchestration-examples.json",
  "orchestrator-state.json",
  "proactive-patterns.json",
  "security.json",
  "shared-history.json",
  "tasks.json",
  "tool-stats.json",
  "trust-engine.json",
  "vulnerable-shares.json",
] as const;

const BRAIN_DIRS: readonly string[] = [
  "agent-runs",
  "dashboards",
  "skills",
] as const;

// `memory.db` is intentionally NOT in this list. The SQLite memory
// store routinely sits in the hundreds of MB once a user has accrued
// real history; shipping that through a git sync-repo on every
// after_chat tick would balloon the repo and saturate bandwidth.
// Memory consistency across machines is a Phase-2 concern that needs
// VACUUM INTO compaction, or sqlite3 .dump + gzip, or an external
// blob store. The memory/ directory of markdown files (synced via
// copyToSync's existing memory-mirror block) carries the durable
// long-term notes that matter most; the .db is a derived index.
const BRAIN_BINARY_FILES: readonly string[] = [] as const;

// Explicit security boundary — these files MUST NEVER be synced. Tokens,
// credentials, and machine-bound encryption keys stay local. Users
// re-create tokens per workstation; that's the security model. Listed
// here so a future maintainer searching for "what about secrets.enc"
// finds an unambiguous answer instead of guessing from omission.
const NEVER_SYNC_DOC: readonly string[] = [
  "master.dpapi",          // Windows DPAPI encryption key — machine-bound
  "secrets.enc",           // Encrypted secrets (decryption key is master.dpapi)
  "secrets.salt",          // Secrets-store salt
  "tokens.json",           // OAuth tokens
  "auth.json",             // Server auth-token file
  "anthropic-auth.json",   // Anthropic OAuth tokens
  "telegram-config.json",  // Bot token
  "whatsapp-auth",         // WhatsApp session credentials
  "voice-auth",            // Voice WS auth state
  "tls",                   // TLS certs / keys
];
void NEVER_SYNC_DOC; // anchored for grep, not used at runtime

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

    // Sidebar pins (user-level UI state — per-user, not per-machine).
    // Extract just the `sidebarPins` key from settings.json and ship it
    // as its own file so machine-specific keys (port, voiceTier4Device,
    // etc.) don't ride along.
    const settingsPath = join(this.dataDir, "settings.json");
    if (existsSync(settingsPath)) {
      try {
        const settings = JSON.parse(readFileSync(settingsPath, "utf-8"));
        const pins = Array.isArray(settings.sidebarPins) ? settings.sidebarPins : [];
        writeFileSync(join(this.syncDir, "sidebar-pins.json"), JSON.stringify(pins, null, 2));
      } catch (e) {
        logger.warn(`[sync] sidebar-pins push skipped: ${(e as Error).message}`);
      }
    }

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
      if (existsSync(workspace)) {
        // Workspace push uses tombstone-driven deletion (see
        // writeTombstonesForDeletedApps + applyTombstones). The mirror is
        // additive-only so local-only apps on other machines aren't
        // obliterated when this machine pushes.
        this.writeTombstonesForDeletedApps();
        this.mirrorDir(workspace, join(this.syncDir, "workspace"), /* additiveOnly */ true);
      }
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

    // Brain backup — flat JSON files. Last-push-wins. Skip if file
    // doesn't exist locally (means the user never created that surface).
    for (const file of BRAIN_JSON_FILES) {
      const src = join(this.dataDir, file);
      if (!existsSync(src)) continue;
      try {
        writeFileSync(join(this.syncDir, file), readFileSync(src, "utf-8"), "utf-8");
      } catch (e) {
        logger.warn(`[sync] brain push skipped ${file}: ${(e as Error).message}`);
      }
    }

    // Brain backup — directory trees. mirrorDir is destructive (matches
    // source on the destination side); the goal here is "the user's
    // workstation should match this push," so destructive mirror is
    // correct.
    for (const dir of BRAIN_DIRS) {
      const src = join(this.dataDir, dir);
      if (!existsSync(src)) continue;
      try {
        this.mirrorDir(src, join(this.syncDir, dir), /* additiveOnly */ false);
      } catch (e) {
        logger.warn(`[sync] brain push skipped dir ${dir}: ${(e as Error).message}`);
      }
    }

    // Brain backup — binary files (currently memory.db). Copy the .db
    // alone; WAL/SHM sidecars are intentionally NOT shipped because
    // SQLite reconstructs them on first read and shipping stale
    // sidecars can corrupt the DB on the destination.
    for (const file of BRAIN_BINARY_FILES) {
      const src = join(this.dataDir, file);
      if (!existsSync(src)) continue;
      try {
        const data = readFileSync(src);
        if (data.length > 100 * 1024 * 1024) {
          logger.warn(`[sync] brain push skipped ${file}: size ${data.length} exceeds 100MB cap`);
          continue;
        }
        writeFileSync(join(this.syncDir, file), data);
      } catch (e) {
        logger.warn(`[sync] brain push skipped ${file}: ${(e as Error).message}`);
      }
    }
  }

  /**
   * Mirror src → dest: copies files. When `additiveOnly` is true, dest entries
   * not in src are LEFT IN PLACE — caller is responsible for tombstone-driven
   * deletion. When false (legacy default), dest entries not in src are removed.
   *
   * The workspace push path (push() → mirrorDir(workspace, …)) MUST pass
   * additiveOnly=true. Otherwise A pushing its workspace deletes B's
   * machine-only apps from sync-repo, which then propagates to all machines
   * on next pull. That's the bug the tombstone system replaces.
   */
  private mirrorDir(src: string, dest: string, additiveOnly = false): void {
    if (!existsSync(dest)) mkdirSync(dest, { recursive: true });
    const srcEntries = new Set<string>();

    for (const entry of readdirSync(src)) {
      const srcPath = join(src, entry);
      const stat = statSync(srcPath);
      if (stat.isDirectory()) {
        if (!SKIP_DIRS.has(entry)) { srcEntries.add(entry); this.mirrorDir(srcPath, join(dest, entry), additiveOnly); }
      } else if (stat.isFile()) {
        const ext = extname(entry).toLowerCase();
        const isDoc = /^(PROJECT|CHANGELOG|TODO|README)\.md$/i.test(entry);
        if ((SYNC_EXTENSIONS.has(ext) || isDoc) && stat.size <= MAX_FILE_SIZE) {
          srcEntries.add(entry);
          writeFileSync(join(dest, entry), readFileSync(srcPath));
        }
      }
    }
    if (!additiveOnly) {
      // Legacy destructive behavior — only safe for caller-controlled trees
      // where remote-state really IS authoritative. NOT safe for workspace.
      for (const entry of readdirSync(dest)) {
        if (!srcEntries.has(entry)) {
          const p = join(dest, entry);
          if (statSync(p).isDirectory()) rmSync(p, { recursive: true, force: true }); else unlinkSync(p);
        }
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

    // Sidebar pins: replace the local sidebarPins array with the remote
    // one. Other settings.json keys (port, voiceTier4Device, etc.) are
    // preserved — only the pins array is overwritten so this machine
    // gets the same sidebar layout as whichever workstation pushed
    // last. If remote file is missing or unreadable, leave local pins
    // alone.
    const syncPins = join(this.syncDir, "sidebar-pins.json");
    if (existsSync(syncPins)) {
      try {
        const remotePins = JSON.parse(readFileSync(syncPins, "utf-8"));
        if (Array.isArray(remotePins)) {
          const localSettingsPath = join(this.dataDir, "settings.json");
          let localSettings: Record<string, unknown> = {};
          if (existsSync(localSettingsPath)) {
            try { localSettings = JSON.parse(readFileSync(localSettingsPath, "utf-8")); } catch { /* swallow */ }
          }
          localSettings.sidebarPins = remotePins;
          writeFileSync(localSettingsPath, JSON.stringify(localSettings, null, 2), "utf-8");
        }
      } catch (e) {
        logger.warn(`[sync] sidebar-pins pull skipped: ${(e as Error).message}`);
      }
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
      if (existsSync(syncWs)) {
        if (!existsSync(ws)) mkdirSync(ws, { recursive: true });
        // Workspace pull is additive-only — files only get copied IN, never
        // deleted by missing-from-remote. Deletions go through tombstones.
        this.pullDir(syncWs, ws, /* additiveOnly */ true);
        this.applyTombstones();
      }
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

    // Brain backup — flat JSON files. Last-push-wins overwrite. Only
    // pull when the remote file exists; never delete a local-only
    // file just because it's missing from the remote (a fresh sync
    // repo wouldn't have these yet).
    for (const file of BRAIN_JSON_FILES) {
      const remote = join(this.syncDir, file);
      if (!existsSync(remote)) continue;
      try {
        writeFileSync(join(this.dataDir, file), readFileSync(remote, "utf-8"), "utf-8");
      } catch (e) {
        logger.warn(`[sync] brain pull skipped ${file}: ${(e as Error).message}`);
      }
    }

    // Brain backup — directory trees. Destructive mirror so the
    // destination matches the remote tree exactly.
    for (const dir of BRAIN_DIRS) {
      const remote = join(this.syncDir, dir);
      if (!existsSync(remote)) continue;
      const local = join(this.dataDir, dir);
      try {
        this.pullDir(remote, local, /* additiveOnly */ false);
      } catch (e) {
        logger.warn(`[sync] brain pull skipped dir ${dir}: ${(e as Error).message}`);
      }
    }

    // Brain backup — binary files (memory.db). Drop any stale
    // .db-wal / .db-shm sidecars before overwriting; SQLite recreates
    // them from the new .db on first read. Without this, a stale WAL
    // pointing at the previous .db can corrupt memory after restore.
    for (const file of BRAIN_BINARY_FILES) {
      const remote = join(this.syncDir, file);
      if (!existsSync(remote)) continue;
      const localPath = join(this.dataDir, file);
      try {
        for (const sidecar of [`${file}-wal`, `${file}-shm`]) {
          const sidecarPath = join(this.dataDir, sidecar);
          if (existsSync(sidecarPath)) { try { unlinkSync(sidecarPath); } catch { /* swallow */ } }
        }
        writeFileSync(localPath, readFileSync(remote));
      } catch (e) {
        logger.warn(`[sync] brain pull skipped ${file}: ${(e as Error).message}`);
      }
    }
  }

  /**
   * Pull from sync → local.
   *
   * When `additiveOnly` is true, local entries missing from src are LEFT
   * ALONE — caller applies tombstones explicitly to drive deletions. When
   * false (legacy), missing-from-remote propagates as a local delete (the
   * old buggy behavior — see writeTombstonesForDeletedApps for the fix).
   *
   * Used additively for workspace pulls; legacy/destructive for older
   * pull paths that still rely on it (none currently — kept for safety).
   */
  private pullDir(src: string, dest: string, additiveOnly = false): void {
    if (!existsSync(dest)) mkdirSync(dest, { recursive: true });
    const remoteEntries = new Set<string>();
    for (const entry of readdirSync(src)) {
      remoteEntries.add(entry);
      const srcPath = join(src, entry);
      const destPath = join(dest, entry);
      const stat = statSync(srcPath);
      if (stat.isDirectory()) {
        this.pullDir(srcPath, destPath, additiveOnly);
      } else if (stat.isFile()) {
        if (!existsSync(destPath) || statSync(destPath).mtimeMs < stat.mtimeMs) writeFileSync(destPath, readFileSync(srcPath));
      }
    }
    if (!additiveOnly) {
      // Legacy: delete local entries removed from sync repo. NOT used for
      // workspace anymore (see applyTombstones).
      for (const entry of readdirSync(dest)) {
        if (!remoteEntries.has(entry)) {
          const p = join(dest, entry);
          logger.info(`[sync] Deleting ${relative(resolve("workspace"), p)} (removed from remote)`);
          if (statSync(p).isDirectory()) rmSync(p, { recursive: true, force: true }); else unlinkSync(p);
        }
      }
    }
  }

  // ── Tombstones — explicit deletion intent across machines ──
  //
  // The bug we replaced: comparing local-vs-remote can't distinguish
  // "deleted on remote" from "never existed on remote." Both look like
  // "missing from remote." That meant any app present on machine A but
  // never on machine B would get deleted from A as soon as B pushed, then
  // propagated to all machines on pull.
  //
  // The fix: every machine maintains a snapshot of which workspace/apps
  // existed at its last push (~/.lax/sync-state/last-pushed-apps.json).
  // On the next push, anything in last-snapshot but missing now = "I
  // intentionally deleted this since last push" → write a tombstone file
  // into sync-repo/.tombstones/<name>.json. Tombstones are git-tracked so
  // they propagate to all machines via the existing sync-repo git push/pull.
  // On pull, every tombstone in remote → ensure local doesn't have that app.
  // Local-only apps (never in last-snapshot, never tombstoned) survive.
  //
  // First-run safety: if the snapshot doesn't exist yet, we initialize it
  // with the current set of apps and write zero tombstones — so a brand
  // new machine doesn't retroactively tombstone every app the user has.

  private get snapshotFile(): string { return join(this.dataDir, "sync-state", "last-pushed-apps.json"); }
  private get tombstonesDir(): string { return join(this.syncDir, ".tombstones"); }
  private get appsDir(): string { return join(resolve("workspace"), "apps"); }

  /** Top-level subdirectories of workspace/apps — these are the units we tombstone. */
  private listWorkspaceApps(): string[] {
    if (!existsSync(this.appsDir)) return [];
    return readdirSync(this.appsDir).filter(e => {
      try { return statSync(join(this.appsDir, e)).isDirectory(); } catch { return false; }
    });
  }

  /**
   * Pre-push: detect apps deleted on this machine since the last push,
   * write tombstones for them into sync-repo/.tombstones/, update the
   * per-machine snapshot. Idempotent — re-running doesn't re-tombstone.
   *
   * Also handles two edge cases that bite without explicit care:
   *   1. Resurrection: an app deleted last cycle and recreated this cycle
   *      keeps getting deleted on every pull because the old tombstone
   *      lingers. We clear the stale tombstone before writing new ones.
   *   2. Sync-repo bloat: additive-only push leaves dead app trees in
   *      sync-repo/workspace/apps/ forever. We prune the tree of any app
   *      we just tombstoned in the same step.
   */
  private writeTombstonesForDeletedApps(): void {
    const current = new Set(this.listWorkspaceApps());
    let last: string[] = [];
    let snapshotExisted = false;
    if (existsSync(this.snapshotFile)) {
      snapshotExisted = true;
      try { last = JSON.parse(readFileSync(this.snapshotFile, "utf-8")); } catch { last = []; }
    }
    if (!snapshotExisted) {
      // First run on this machine — DO NOT tombstone everything not in snapshot.
      // Just initialize snapshot to current state. Future pushes will detect
      // real deletions vs. this baseline.
      mkdirSync(dirname(this.snapshotFile), { recursive: true });
      writeFileSync(this.snapshotFile, JSON.stringify([...current].sort(), null, 2));
      logger.info(`[sync] tombstone snapshot initialized (${current.size} apps baseline)`);
      return;
    }

    // Resurrection: clear any tombstone for an app that exists locally again.
    // Without this, the old tombstone keeps deleting the recreated app on
    // every pull anywhere in the fleet.
    if (existsSync(this.tombstonesDir)) {
      for (const file of readdirSync(this.tombstonesDir)) {
        if (!file.endsWith(".json")) continue;
        const name = file.slice(0, -5);
        if (current.has(name)) {
          try {
            unlinkSync(join(this.tombstonesDir, file));
            logger.info(`[sync] tombstone cleared — "${name}" exists again locally`);
          } catch (e) {
            logger.warn(`[sync] failed to clear tombstone for ${name}: ${(e as Error).message}`);
          }
        }
      }
    }

    const deletedSinceLast = last.filter(name => !current.has(name));
    if (deletedSinceLast.length > 0) {
      if (!existsSync(this.tombstonesDir)) mkdirSync(this.tombstonesDir, { recursive: true });
      for (const name of deletedSinceLast) {
        const tombstone = { name, deletedAt: new Date().toISOString(), deletedBy: hostname() };
        writeFileSync(join(this.tombstonesDir, `${name}.json`), JSON.stringify(tombstone, null, 2));
        logger.info(`[sync] tombstone written for "${name}" (deleted on ${tombstone.deletedBy})`);
        // Prune the dead app tree from sync-repo so it doesn't accumulate.
        // additiveOnly mirroring leaves these behind otherwise.
        const syncAppDir = join(this.syncDir, "workspace", "apps", name);
        if (existsSync(syncAppDir)) {
          try { rmSync(syncAppDir, { recursive: true, force: true }); }
          catch (e) { logger.warn(`[sync] failed to prune sync-repo/${name}: ${(e as Error).message}`); }
        }
      }
    }
    // Update snapshot to current state
    writeFileSync(this.snapshotFile, JSON.stringify([...current].sort(), null, 2));
  }

  /**
   * Post-pull: read tombstones in sync-repo and ensure local doesn't have
   * any tombstoned apps. Idempotent — apps already absent locally are skipped.
   */
  private applyTombstones(): void {
    if (!existsSync(this.tombstonesDir)) return;
    if (!existsSync(this.appsDir)) return;
    for (const file of readdirSync(this.tombstonesDir)) {
      if (!file.endsWith(".json")) continue;
      const name = file.slice(0, -5);
      const localApp = join(this.appsDir, name);
      if (existsSync(localApp)) {
        logger.info(`[sync] tombstone — removing local "${name}"`);
        try { rmSync(localApp, { recursive: true, force: true }); } catch (e) {
          logger.warn(`[sync] tombstone removal failed for ${name}: ${(e as Error).message}`);
        }
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
    };
  }
}
