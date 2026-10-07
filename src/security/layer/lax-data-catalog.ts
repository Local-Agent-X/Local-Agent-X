/**
 * Every location in the `.lax` data dir, by what an agent write there means.
 *
 * The server trusts what it finds here: settings, schedules, plugins, the
 * programs it runs, the memory it reads into every chat. So the default for a
 * file-tool write anywhere in the data dir is the user's yes
 * (tool-execution/control-file-gate.ts), and only the agent's own working
 * data, which the app stores, serves, shows or plays but never acts on, is
 * written without one. A location missing from this table is put to the user
 * with a generic description, never let through.
 *
 *   "data"    — written with no card. `note` says why that is safe.
 *   "card"    — the user is asked. `note` finishes "…, which <note>." on the card.
 *   "blocked" — a security switch the agent must never flip, refused outright
 *               (lax-control-files.ts isLaxControlFile, enforced by
 *               file-access.ts). `note` is what it switches.
 *
 * `rel` is the location under the data dir, one segment per element, `*`
 * standing for any one segment. A folder entry covers everything inside it,
 * and the longest matching entry wins, so a folder can hold one location
 * that differs from it (workspace/voice-chat, cron/jobs.json,
 * trash/task/…/.manifest.json).
 *
 * lax-data-catalog.contract.test.ts scans src/ for every name joined onto the
 * data dir and fails until a new one is entered here.
 */

export type LaxDataKind = "data" | "card" | "blocked";

export interface LaxDataEntry {
  readonly rel: readonly string[];
  readonly kind: LaxDataKind;
  readonly note: string;
}

function at(kind: LaxDataKind, note: string, ...locations: string[]): LaxDataEntry[] {
  return locations.map((location) => ({ rel: location.split("/"), kind, note }));
}

const REMEMBERS = "is part of what the agent remembers and reads back into your chats";
const INSTRUCTIONS = "holds instructions the agent follows";
const AGENTS = "defines the agents it hands work to: their instructions, tools and schedules";
const SCHEDULE = "decides what the agent runs on its own, and when";
const BROWSER = "is the in-app browser's own profile: its sign-ins, cookies, history and extensions";
const ACCOUNT = "holds a sign-in the app uses for one of your accounts";
const PROGRAMS = "holds programs or models the app runs";
const UPDATES = "holds app updates and what an update puts back";
const AUDIT = "is the security audit trail";
const MCP_TRUST = "decides which MCP server programs the app trusts";
const CHANNELS = "decides who can reach the agent over Telegram or WhatsApp";
const VOICE_ID = "decides whose voice the app recognizes as yours";
const SETTINGS = "holds settings the app reads back";
const RECORDS = "is a record the app keeps of its own work and reads back";
const RUNNING = "is part of the app's running state";

export const LAX_DATA_CATALOG: readonly LaxDataEntry[] = [
  // Each switches part of the leash itself, and the user changes it in
  // Settings or on the Missions page, never through the agent.
  ...at("blocked", "holds your security settings: developer mode, tool approval, the shell switch", "settings.json"),
  ...at("blocked", "holds the app's runtime configuration, including its own access token", "config.json"),
  ...at("blocked", "decides which tools the agent may use", "tool-policy.json"),
  ...at("blocked", "decides which websites the agent may reach and which local ports it may use", "security.json"),
  ...at("blocked", "lists the websites the agent may send data to", "egress-allowlist.json"),
  ...at("blocked", "decides how much the agent may do without asking you", "autonomy-profile.json"),
  ...at("blocked", "records your consent to run the shell without its sandbox", "sandbox-host-acknowledgement.json"),
  ...at("blocked", "decides whether the app's server starts inside its sandbox", "server-sandbox-boot.json"),
  ...at("blocked", "decides which access tokens the app accepts and what each may do", "tokens.json"),
  ...at("blocked", "lists the data flows you approved, which then run without asking", "threat-trust-ledger.json"),
  // A mission's own autonomy profile lets its unattended runs act without
  // asking, and the mission tools refuse to grant one (cron/job-authority.ts).
  ...at("blocked", "holds your missions and the autonomy profile each one runs under when no one is watching", "cron/jobs.json"),
  // The repository the sync heartbeat pushes memory and chats to over git,
  // a channel the egress gate never sees.
  ...at("blocked", "decides where sync sends your memory and chats", "sync-config.json"),

  // Read back as instructions the app carries out on this computer.
  ...at("card", "runs commands on every tool call", "hooks.json"),
  ...at("card", "decides which MCP servers start", "mcp.json"),
  ...at("card", "decides which MCP servers run trusted on this computer, outside the sandbox", "mcp-local-trust.json"),
  ...at("card", MCP_TRUST, "mcp-trust.json", "mcp-signed-manifests.json"),
  ...at("card", "holds plugins, whose code loads into the app when it starts", "plugins"),
  ...at("card", "decides which plugins load into the app when it starts", "plugins/registry.json"),
  ...at("card", "decides whose plugins the app trusts", "trusted-publishers.json"),
  ...at("card", "lists what an undo copies back into your files and git repositories", "rollback"),
  ...at("card", "decides where a restore puts deleted files back", "trash-journal.jsonl", "trash"),
  ...at("card", "decides where a restore puts the agent's deleted files back", "trash/task/*/.manifest.json"),
  ...at("card", "decides which services the agent calls with your saved keys, and at what addresses", "integrations.json"),
  ...at("card", "defines the connectors the agent can call, and what each may reach", "connectors"),
  ...at("card", "lists the dev servers the app started, whose ports the shell may reach", "dev-servers"),
  ...at("card", "records where content came from, which the safety checks rely on", "provenance"),
  ...at("card", "decides which chat accounts count as you", "identity-links.json"),
  ...at("card", "is the sync copy that the next sync merges into this computer", "sync-repo"),
  ...at("card", "holds the configuration the app hands to the helper programs it starts", "tmp"),
  ...at("card", "holds the sign-in link the app points you to", ".startup-url"),
  ...at("card", "holds the uninstall script the app runs when you remove it", "uninstall"),
  ...at("card", "decides what autopilot runs", "autopilot.config.json"),
  ...at("card", "decides what a self_edit undo rolls back", "last-self-edit-merge.json"),
  ...at("card", "holds your apps' data and permissions, and their signed audit trail", "apps"),
  ...at("card", "holds snapshots of your apps that a restore copies back", "app-snapshots"),
  ...at("card", "holds downloads the app is still checking before you get them", "browser-quarantine"),
  ...at("card", "holds the agent's queued and running work, which the app resumes", "operations", "operation-batches"),
  ...at("card", PROGRAMS, "models", "pocket-tts", "tesseract", "python-voice", "python-chatterbox", "python-voxcpm", "runtime", "workspace/voice-chat"),
  ...at("card", UPDATES, "updates", "update-rollback", "backups", "installed-source.json", "update-history.json", "update-health.json", "desktop-prebuild-pending.json"),
  ...at("card", SCHEDULE, "cron", "custom-missions.json", "mission-schedules.json", "autopilot"),
  ...at("card", AGENTS, "agent-templates.json", "agent-projects.json", "project-rosters.json"),
  ...at("card", INSTRUCTIONS, "skills", "protocols", "custom-protocols.json", "protocol-variables.json", "protocol-prefs", "orchestration-examples.json"),
  ...at("card", CHANNELS, "telegram-config.json", "whatsapp-config.json"),
  ...at("card", VOICE_ID, "voice-auth", "speakers"),
  ...at("card", BROWSER, "chrome-profile", "chrome-profile-pw", "chrome-chat-profiles", "browser-history.json", "browser-bookmarks.json",
    "browser-continuity-state.json", "browser-continuity-cache-state.json"),
  ...at("card", ACCOUNT, "anthropic-auth.json", "xai-auth.json", "agentxos-account.json", "agentxos-identity.json", "email.json",
    "secrets-vault.json", "whatsapp-auth"),
  ...at("card", AUDIT, "audit", "ari-audit.db"),
  ...at("card", REMEMBERS, "memory", "memory.db", "memory-atlas.cache.json", "memory-compressed", "memory-tiers.json", "sessions",
    "sessions-archive", "dream-state.json", "consolidation-log.json", "cross-session-data.json", "capability-gaps.jsonl",
    "contradiction-history.json", "correction-history.json", "corrections.json", "emotional-history.json", "inside-references.json",
    "language-style.json", "milestones.json", "narratives.json", "proactive-patterns.json", "schedule-profile.json",
    "shared-history.json", "topic-frequencies.json", "trust-engine.json", "unspoken-detector.json", "upcoming-events.json",
    "vulnerable-shares.json", "vulnerability-shares.json", "calendar.json", "tasks.json"),
  ...at("card", SETTINGS, "bridge-voice-prefs.json", "office-theme.json", "tool-timeouts.json", "model-capabilities.json",
    "model-profiles", "local-context-sizing.json", "local-model-certifications.json"),
  ...at("card", RECORDS, "action-log", "active-orchestrators.json", "agent-issues.json", "agent-runs", "app-build-workflows.json",
    "auto-delegate-decisions.jsonl", "crash-log.json", "dashboards", "db.sqlite", "install-report.json", "marketplace-cache.json",
    "migration-version.json", "orchestrator-state.json", "p1-metrics.json", "prompt-captures", "provider-health.json", "restart-notify.json",
    "run-traces", "sync-state", "telemetry", "tool-rag-cache.json", "tool-stats.json", "usage-log.json", "user-notices.json",
    "voice-timeline"),
  ...at("card", RUNNING, "run", "cr", "server.pid", ".doctor-check", ".startup-test-probe"),

  // The agent's working data: stored, served, shown or played, never acted on.
  ...at("data", "the agent's workspace, where it keeps one inside the data folder: its everyday write zone", "workspace"),
  ...at("data", "files you attach and media the agent makes, served back to you and never read as instructions", "uploads"),
  ...at("data", "copies of images fetched for the agent to look at", "image-cache"),
  ...at("data", "screen recordings kept for you to watch", "recordings"),
  ...at("data", "the short sounds voice chat plays", "audio-cues"),
  ...at("data", "scratch audio for voice chat, deleted after use", "voice-tmp"),
  ...at("data", "diagnostic logs, read to explain a failure and never acted on", "logs", "sidecars"),
];

/** What Local Agent X does with a data-dir location the table does not name. */
export const UNLISTED_LAX_NOTE = "Local Agent X keeps for itself and reads back";

function matches(rel: readonly string[], below: readonly string[]): boolean {
  return rel.length <= below.length && rel.every((seg, i) => seg === "*" || seg === below[i]);
}

/**
 * The entry for a location given as its lowercased segments below the data
 * dir, or null when the table does not name it.
 */
export function laxDataEntry(below: readonly string[]): LaxDataEntry | null {
  let best: LaxDataEntry | null = null;
  for (const entry of LAX_DATA_CATALOG) {
    if (matches(entry.rel, below) && (!best || entry.rel.length > best.rel.length)) best = entry;
  }
  return best;
}
