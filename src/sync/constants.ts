import { homedir } from "node:os";

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

export const DEFAULT_CONFIG: SyncConfig = {
  enabled: false, repoUrl: "", tokenSecretName: "GITHUB_SYNC_TOKEN",
  interval: "after_chat", syncSessions: true, syncWorkspace: false, syncCronJobs: false, autoDownload: true,
};

export const SYNC_EXTENSIONS = new Set([
  ".html", ".css", ".js", ".ts", ".tsx", ".jsx", ".json", ".jsonl", ".md", ".txt",
  ".yaml", ".yml", ".toml", ".svg", ".env.example", ".py", ".sh", ".bat",
  ".sql", ".graphql", ".png", ".jpg", ".jpeg", ".gif", ".webp", ".ico",
  ".bmp", ".mp4", ".webm", ".mov", ".mp3", ".wav", ".ogg", ".pdf", ".csv",
]);

export const SKIP_DIRS = new Set([
  "node_modules", ".next", "dist", "build", ".cache", "__pycache__",
  ".git", ".venv", "venv", "sd-server", "models", "checkpoints", "weights",
]);

export const MAX_FILE_SIZE = 10_000_000;

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
export const BRAIN_JSON_FILES: readonly string[] = [
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

export const BRAIN_DIRS: readonly string[] = [
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
export const BRAIN_BINARY_FILES: readonly string[] = [] as const;

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

// Rewrite this machine's home-dir literal into the ${HOME} placeholder
// that mcp-client.ts expands at load time on the destination machine.
// Without this, an MCP server entry like
//   ["@modelcontextprotocol/server-filesystem", "C:/Users/manri/Documents"]
// pushed from this box would ENOENT on every other machine that doesn't
// have a "manri" user. Matches both forward-slash form (C:/Users/manri)
// and JSON-escaped backslash form (C:\\Users\\manri); case-insensitive
// for Windows. Belt-and-suspenders to mcp-client's runtime expansion —
// the bytes on the wire stay portable even if expansion regresses.
export function canonicalizeHomePaths(jsonText: string): string {
  const home = homedir();
  if (!home) return jsonText;
  const escapeRegex = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const homeForward = home.replace(/\\/g, "/");
  const homeJsonEscaped = home.replace(/\\/g, "\\\\");
  let out = jsonText;
  out = out.replace(new RegExp(escapeRegex(homeForward), "gi"), "${HOME}");
  if (homeJsonEscaped !== homeForward) {
    out = out.replace(new RegExp(escapeRegex(homeJsonEscaped), "gi"), "${HOME}");
  }
  return out;
}
