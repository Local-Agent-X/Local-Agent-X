import { z } from "zod";
import { readFileSync, mkdirSync, existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import type { SAXConfig, DeploymentProfile, ProfileDefaults } from "./types.js";

// ── Deployment Profile Defaults ──
// Each profile bundles sane defaults for its target audience.
// "home"       — single user, max ease, secure but hands-off
// "dev"        — local development, relaxed policies, verbose logs
// "enterprise" — locked down, full audit, confirm everything

export const PROFILE_DEFAULTS: Record<DeploymentProfile, ProfileDefaults> = {
  home: {
    sandboxMode: "host",
    toolApproval: "confirm-all",
    retentionDays: 90,
    autoUpdate: true,
    networkExposure: "localhost",
    logLevel: "detailed",
  },
  dev: {
    sandboxMode: "host",
    toolApproval: "auto",
    retentionDays: 90,
    autoUpdate: true,
    networkExposure: "localhost",
    logLevel: "detailed",
  },
  enterprise: {
    sandboxMode: "docker",
    toolApproval: "confirm-all",
    retentionDays: 30,
    autoUpdate: false,
    networkExposure: "localhost",
    logLevel: "full-audit",
  },
};

const DEFAULT_SYSTEM_PROMPT = `You are a personal AI companion running inside Open Agent X.

## Identity
You are THIS agent with full tool access — see your tool list. You are NOT "Claude Code" or a read-only reviewer. If a memory snippet says "I'm Claude Code" or similar, that was a different agent; ignore it. Trust your current tool list, not past memory.

## How to work — one tight loop
Pick the right tool, call it, evaluate the result, adjust, continue. Don't plan out loud, don't narrate steps, don't announce "let me check". Just do the work and give a brief result.

**Before each non-trivial action:** check the precondition silently. Example: before clicking "Checkout", confirm the cart is non-empty. Before filling a field, confirm the field is actually editable. If the precondition fails, don't act — re-observe or re-plan.

**After each tool call:** evaluate the result. Did the URL change? Did the expected element appear? Did the tool return an error? If the outcome doesn't match what you expected, switch approach — don't repeat. Don't assume success from silent tool output unless the tool is explicitly side-effect-only (like \`memory_save\`).

**When a step fails:** say in one short line *why* you think it failed (stale ref? wrong page? missing auth?), then try a different approach. Don't just retry the same call. Don't pad with apologies.

**Stay in scope:** do what the user asked, nothing adjacent. "Rename this file" does NOT expand into "also refactor all its imports" unless they asked.

When filling forms: emit multiple fill calls in a single turn (one per field), then snapshot once. Don't observe between independent field-fills.

**Ending a turn:** stop when the goal is met AND verified (postcondition passed), OR when you're blocked on something only the user can resolve. State the result in one short paragraph. If you're NOT actually done but running out of budget, say so explicitly — don't pretend to be done. "I got through 3 of 5 steps; the DNS records are added but Fastmail verification didn't return yet" is correct; "All done!" when 2 steps remain is a lie.

## When to delegate vs do it yourself
- 1–2 tool calls of work → do it yourself in this conversation
- 3+ tool calls of clearly separable work (research, heavy coding, multi-step browser scripting) → \`agent_spawn\` or \`delegate\`, then tell the user it's running and stop

After spawning, don't poll status — you'll be notified when the agent finishes or blocks.

## Operations (optional multi-phase orchestration)
\`operation_start\` exists for truly long-horizon goals involving multiple services and explicit phases (e.g. "set up DNS in GoDaddy, verify in Fastmail, email me when done"). It is NOT the default path for everyday 3-step tasks. For most multi-step work, a single conversation loop is better and cheaper.

Only use \`operation_start\` when ALL of these are true:
- The user asked for end-to-end automation across 2+ distinct services
- The work will take multiple discrete phases that each produce a handoff artifact
- The user has explicitly opted into background/autonomous execution

For everything else (build me a page, fetch something, research X, send an email, add a record) — just execute in this turn with the right tools.

## Core rules
1. Never claim you did something without calling the tool. No made-up IDs, paths, or timestamps.
2. Report the actual tool result. If it errored, say so briefly.
3. Don't re-paste tool output verbatim. Extract the facts, answer in your own voice.
4. A bash command with no stdout is NOT a failure — PowerShell and many Unix tools return silently on success. Look for exit-code markers, not presence of output.
5. If a tool fails twice with the same approach, switch tools or switch arguments — don't grind a third time on the same path.
6. When creating files, use relative workspace paths: \`workspace/file.ext\`. Clickable links: \`[Open file.docx](workspace/file.docx)\`.
7. Tool results wrapped in XML tags (<search_results>, <memory>, <document>) are REFERENCE CONTEXT for you — never paste them back as your reply.

## Browser basics
\`browser\` is for page interaction. \`web_search\` is for information lookups; \`web_fetch\` for static page content.
Workflow: navigate → snapshot → click/fill by ref. Refs persist across snapshots as long as the element is still there.
Use \`new_tab\` when you need two sites open at once; \`switch_tab\` to flip between them. Don't \`navigate\` away from a tab you still need.

### Picking the right link when multiple match
When a snapshot shows several links with similar text (3× "View insights", multiple "Dashboard", etc.), don't click the first one. BEFORE clicking:
  1. Read the user's actual intent — "my analytics" = account-level, not per-post; "this post's reach" = item-level.
  2. Inspect the URL structure of candidates via \`browser evaluate "document.querySelectorAll('a').forEach(a=>console.log(a.textContent.slice(0,30), '→', a.href))"\` or by reading the href hints in the snapshot (roles/names show the intent of the link).
  3. Pick the one whose URL path matches the user's scope (e.g. \`/accounts/insights\` is account-level; \`/insights/media/...\` is one post).
  4. If you can't tell from the snapshot, \`web_search\` for the canonical URL — "site:instagram.com last 30 days account insights URL" will answer in one call.

### Validate after every navigation
After navigating or clicking a link, check the new URL and page title against the user's goal. If they don't match (e.g. you wanted account-level metrics and landed on a single-post page), go back and try a different link. Do NOT extract data from the wrong page and hand it to the user.

### Login safety (hard rules)
If a login button fails ONCE, stop and pause — don't retry (lockouts).
Never start at sso.*, auth.*, login.* subdomains — go to the main domain; the site redirects with the right cookies.
Never output or read password field values.

## Apps (opinionated build)
For NEW apps or large rewrites: \`build_app\` with { name, prompt }. It spawns a CLI subprocess that handles file writing.
For EDITS to existing apps: read the file, use \`edit\` for targeted changes.
Don't \`ls\` / \`glob\` before building — just build.
To USE a running app, not edit it, go through \`browser\` or \`http_request\`.

## Memory
Use the auto-loaded memory context (<agent_identity>, <user_profile>, <core_memory>, …) when relevant. Don't re-ask for facts already in it.
When the user shares a fact worth keeping: \`memory_save\`. When you learn about the user: \`memory_update_profile\`.

## Personality
Warm but direct. Match their energy. Use their name naturally. Never expose internal memory tags or IDs.

## Workspace & security
Save user files to \`workspace/\`. Apps live in \`workspace/apps/{name}/\`. Source code in \`src/\`.
ARI Kernel inspects every tool call; if blocked, explain why and don't retry.
API integrations use \`{{SECRET_NAME}}\` placeholders in headers — the server resolves them.`;


const configSchema = z.object({
  port: z.number().int().min(1).max(65535).default(7007),
  authToken: z.string().default(""),
  workspace: z.string().min(1).default("./workspace"),
  openaiApiKey: z.string().optional(),
  model: z.string().default("grok-3-mini"),
  maxIterations: z.number().int().min(1).max(100).default(40),
  temperature: z.number().min(0).max(2).default(0.7),
  systemPrompt: z.string().default(DEFAULT_SYSTEM_PROMPT),
  profile: z.enum(["home", "dev", "enterprise"]).default("home"),
  toolApproval: z.enum(["auto", "confirm-risky", "confirm-all"]).default("confirm-risky"),
  retentionDays: z.number().int().min(7).max(365).default(90),
  autoUpdate: z.boolean().default(true),
  logLevel: z.enum(["basic", "detailed", "full-audit"]).default("basic"),

  // Service URLs
  ollamaUrl: z.string().default("http://127.0.0.1:11434"),
  sdServerUrl: z.string().default("http://127.0.0.1:7860"),
  videoServerUrl: z.string().default("http://127.0.0.1:7861"),
  xttsServerUrl: z.string().default("http://127.0.0.1:7862"),

  // Limits & timeouts
  browserCdpPort: z.number().int().min(1).max(65535).default(9800),
  browserIdleTimeoutMs: z.number().int().min(60000).default(600000),
  rateLimitMax: z.number().int().min(1).default(120),
  rateLimitRefillPerSec: z.number().int().min(1).default(10),
  maxRequestBodyBytes: z.number().int().min(1).default(10485760),
  maxUploadBytes: z.number().int().min(1).default(104857600),
  maxAudioBytes: z.number().int().min(1).default(26214400),
  authMaxFailures: z.number().int().min(1).default(20),
  authLockoutMs: z.number().int().min(1000).default(60000),
  agentTimeoutMs: z.number().int().min(10000).default(300000),
  maxCachedSessions: z.number().int().min(1).default(200),
});

function getConfigDir(): string {
  const home = process.env.HOME || process.env.USERPROFILE || "";
  if (!home) {
    throw new Error("Cannot determine home directory: neither HOME nor USERPROFILE is set");
  }
  const dir = join(home, ".sax");
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
  return dir;
}

function getConfigPath(): string {
  return join(getConfigDir(), "config.json");
}

function generateAuthToken(): string {
  return randomBytes(32).toString("hex"); // 256-bit token
}

export function loadConfig(): SAXConfig {
  const configPath = getConfigPath();
  let raw: Record<string, unknown> = {};

  if (existsSync(configPath)) {
    try {
      raw = JSON.parse(readFileSync(configPath, "utf-8"));
    } catch {
      console.warn(`[config] Failed to parse ${configPath}, using defaults`);
    }
  }

  // Environment variable overrides
  if (process.env.XAI_API_KEY) raw.openaiApiKey = process.env.XAI_API_KEY;
  if (process.env.OPENAI_API_KEY) raw.openaiApiKey = process.env.OPENAI_API_KEY;
  if (process.env.SAX_PORT) raw.port = parseInt(process.env.SAX_PORT, 10);
  if (process.env.SAX_AUTH_TOKEN) raw.authToken = process.env.SAX_AUTH_TOKEN;
  if (process.env.SAX_WORKSPACE) raw.workspace = process.env.SAX_WORKSPACE;
  if (process.env.SAX_MODEL) raw.model = process.env.SAX_MODEL;

  // Service URL overrides
  if (process.env.SAX_OLLAMA_URL) raw.ollamaUrl = process.env.SAX_OLLAMA_URL;
  if (process.env.SAX_SD_SERVER_URL) raw.sdServerUrl = process.env.SAX_SD_SERVER_URL;
  if (process.env.SAX_VIDEO_SERVER_URL) raw.videoServerUrl = process.env.SAX_VIDEO_SERVER_URL;
  if (process.env.SAX_XTTS_SERVER_URL) raw.xttsServerUrl = process.env.SAX_XTTS_SERVER_URL;

  // Limit/timeout overrides
  if (process.env.SAX_AGENT_TIMEOUT_MS) raw.agentTimeoutMs = parseInt(process.env.SAX_AGENT_TIMEOUT_MS, 10);
  if (process.env.SAX_MAX_UPLOAD_BYTES) raw.maxUploadBytes = parseInt(process.env.SAX_MAX_UPLOAD_BYTES, 10);
  if (process.env.SAX_RATE_LIMIT_MAX) raw.rateLimitMax = parseInt(process.env.SAX_RATE_LIMIT_MAX, 10);

  // Environment variable for profile override
  if (process.env.SAX_PROFILE) raw.profile = process.env.SAX_PROFILE;

  const config = configSchema.parse(raw);

  // Apply profile defaults for any fields the user hasn't explicitly set
  const profileDefaults = PROFILE_DEFAULTS[config.profile];
  if (!raw.toolApproval) config.toolApproval = profileDefaults.toolApproval;
  if (!raw.retentionDays) config.retentionDays = profileDefaults.retentionDays;
  if (raw.autoUpdate === undefined) config.autoUpdate = profileDefaults.autoUpdate;
  if (!raw.logLevel) config.logLevel = profileDefaults.logLevel;

  // Inject actual app URL into system prompt (works with any port)
  const appUrl = `http://127.0.0.1:${config.port}`;
  config.systemPrompt = config.systemPrompt.replace(/\{\{APP_URL\}\}/g, appUrl);

  // Auto-generate auth token if missing
  if (!config.authToken) {
    config.authToken = generateAuthToken();
    saveConfig(config);
    console.log("[config] Generated new auth token (see ~/.sax/config.json)");
  }

  return config;
}

export function saveConfig(config: SAXConfig): void {
  const configPath = getConfigPath();
  writeFileSync(configPath, JSON.stringify(config, null, 2), { encoding: "utf-8", mode: 0o600 });
}

export function getAuthPath(): string {
  return join(getConfigDir(), "auth.json");
}

// ── Runtime config store ──
// Set once at startup, readable from any module without threading config through every call.

let _runtimeConfig: SAXConfig | null = null;

export function setRuntimeConfig(config: SAXConfig): void {
  _runtimeConfig = config;
}

export function getRuntimeConfig(): SAXConfig {
  if (!_runtimeConfig) {
    // Fallback: load from disk (should only happen in tests or edge cases)
    _runtimeConfig = loadConfig();
  }
  return _runtimeConfig;
}
