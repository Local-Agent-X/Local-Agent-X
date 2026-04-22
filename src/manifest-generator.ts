/**
 * App Manifest Generator — scans the codebase and produces config/app-manifest.json.
 *
 * This gives the agent a complete map of its own app: every page, tab, route,
 * setting, tool, and capability. The agent reads this to know what already exists
 * so it doesn't rebuild things and knows where to make changes.
 *
 * Runs at startup and hot-reloads when source files change.
 */

import { readFileSync, writeFileSync, existsSync, readdirSync, watch } from "node:fs";
import { join, resolve } from "node:path";

const ROOT = resolve(join(import.meta.dirname || ".", ".."));
const CONFIG_DIR = join(ROOT, "config");
const MANIFEST_PATH = join(CONFIG_DIR, "app-manifest.json");

interface AppManifest {
  generatedAt: string;
  pages: PageEntry[];
  settingsTabs: TabEntry[];
  agentTabs: TabEntry[];
  apiRoutes: RouteEntry[];
  tools: ToolSummary[];
  apps: AppEntry[];
  configFiles: ConfigFileEntry[];
  bridges: string[];
  integrations: string[];
}

interface PageEntry { name: string; path: string; description: string }
interface TabEntry { name: string; id: string; description: string }
interface RouteEntry { method: string; path: string; description: string }
interface ToolSummary { name: string; description: string; readOnly: boolean }
interface AppEntry { name: string; path: string; files: string[] }
interface ConfigFileEntry { path: string; description: string; agentEditable: boolean }

// ── Scanners ──

function scanPages(): PageEntry[] {
  const pages: PageEntry[] = [
    { name: "Chat", path: "/", description: "Main chat interface — send messages, use voice, attach files" },
    { name: "Settings", path: "/settings.html", description: "Configuration dashboard — AI providers, memory, security, bridges, integrations" },
  ];
  // Scan for additional HTML pages
  const publicDir = join(ROOT, "public");
  try {
    for (const file of readdirSync(publicDir)) {
      if (file.endsWith(".html") && !["index.html", "app.html", "settings.html"].includes(file)) {
        pages.push({ name: file.replace(".html", ""), path: `/${file}`, description: `Static page: ${file}` });
      }
    }
  } catch {}
  return pages;
}

function scanSettingsTabs(): TabEntry[] {
  return [
    { name: "Account", id: "stab-general", description: "OpenAI/Anthropic auth, Claude CLI setup, server config" },
    { name: "AI & Models", id: "stab-ai", description: "Provider selection (xAI, Gemini, OpenAI, Anthropic, local), temperature, max iterations" },
    { name: "Memory", id: "stab-memory", description: "Embedding provider, reranking, conversation import, consolidation" },
    { name: "Media", id: "stab-image", description: "Image/video generation, speech-to-text (Whisper), text-to-speech (Kokoro/Piper)" },
    { name: "Security", id: "stab-security", description: "Tool policy toggles (bash, HTTP, browser), file access modes, approval settings" },
    { name: "Communication", id: "stab-whatsapp", description: "WhatsApp Bridge QR connect, Telegram bot setup" },
    { name: "Integrations", id: "stab-integrations", description: "Connected APIs & custom integration manager" },
    { name: "Sync", id: "stab-sync", description: "GitHub memory sync, frequency settings, workspace sync" },
  ];
}

function scanAgentTabs(): TabEntry[] {
  return [
    { name: "Team", id: "agents-tab-team", description: "Agent roster — spawn, hire, view status of all agents" },
    { name: "Org Chart", id: "agents-tab-orgchart", description: "Visual hierarchy of agent teams and reporting structure" },
    { name: "Inbox", id: "agents-tab-inbox", description: "Agent proposals and messages awaiting review" },
    { name: "Issues", id: "agents-tab-issues", description: "Issue tracking with status workflow" },
    { name: "Templates", id: "agents-tab-templates", description: "Agent template library for reusable roles" },
    { name: "History", id: "agents-tab-history", description: "Agent run history with filtering by status" },
  ];
}

function scanApiRoutes(): RouteEntry[] {
  // Scan route files for registered endpoints
  const routes: RouteEntry[] = [];
  const routeDir = join(ROOT, "src", "routes");
  try {
    for (const file of readdirSync(routeDir)) {
      if (!file.endsWith(".ts")) continue;
      const content = readFileSync(join(routeDir, file), "utf-8");
      // Match patterns like: app.get("/api/...", ...) or router.post("/api/...", ...)
      const regex = /\.(get|post|put|patch|delete)\s*\(\s*["'`]([^"'`]+)["'`]/gi;
      let match;
      while ((match = regex.exec(content)) !== null) {
        const method = match[1].toUpperCase();
        const path = match[2];
        // Try to extract a comment or description near this line
        const lineStart = content.lastIndexOf("\n", match.index);
        const precedingLine = content.slice(Math.max(0, lineStart - 80), match.index).trim();
        const comment = precedingLine.match(/\/\/\s*(.+)$/m)?.[1] || "";
        routes.push({ method, path, description: comment || `${method} ${path}` });
      }
    }
  } catch {}
  // Also check server.ts for top-level routes
  try {
    const serverContent = readFileSync(join(ROOT, "src", "server.ts"), "utf-8");
    const regex = /\.(get|post|put|patch|delete)\s*\(\s*["'`]([^"'`]+)["'`]/gi;
    let match;
    while ((match = regex.exec(serverContent)) !== null) {
      const method = match[1].toUpperCase();
      const path = match[2];
      if (!routes.some(r => r.method === method && r.path === path)) {
        routes.push({ method, path, description: `${method} ${path}` });
      }
    }
  } catch {}
  return routes;
}

function scanTools(): ToolSummary[] {
  const tools: ToolSummary[] = [];
  const toolFiles = ["src/tools.ts", "src/memory/tools.ts", "src/browser-tools.ts", "src/operations/tools.ts"];

  for (const relPath of toolFiles) {
    const filePath = join(ROOT, relPath);
    try {
      const content = readFileSync(filePath, "utf-8");
      // Match tool definitions: { name: "xxx", description: "yyy", readOnly: true/false }
      const nameRegex = /name:\s*["'`]([^"'`]+)["'`]/g;
      const descRegex = /description:\s*\n?\s*["'`]([^"'`]+)/g;
      const readOnlyRegex = /readOnly:\s*(true|false)/g;

      const names: string[] = [];
      const descs: string[] = [];
      const readOnlys: boolean[] = [];

      let m;
      while ((m = nameRegex.exec(content)) !== null) names.push(m[1]);
      while ((m = descRegex.exec(content)) !== null) descs.push(m[1].slice(0, 100));
      while ((m = readOnlyRegex.exec(content)) !== null) readOnlys.push(m[1] === "true");

      for (let i = 0; i < names.length; i++) {
        if (!tools.some(t => t.name === names[i])) {
          tools.push({
            name: names[i],
            description: descs[i] || "",
            readOnly: readOnlys[i] || false,
          });
        }
      }
    } catch {}
  }
  return tools;
}

function scanApps(): AppEntry[] {
  const apps: AppEntry[] = [];
  const appsDir = join(ROOT, "workspace", "apps");
  try {
    for (const name of readdirSync(appsDir)) {
      const appDir = join(appsDir, name);
      try {
        const files = readdirSync(appDir).filter(f => !f.startsWith("."));
        apps.push({ name, path: `workspace/apps/${name}`, files });
      } catch {}
    }
  } catch {}
  return apps;
}

function scanConfigFiles(): ConfigFileEntry[] {
  const configs: ConfigFileEntry[] = [
    { path: "config/system-prompt.md", description: "Agent's system prompt — edit to change behavior, personality, rules", agentEditable: true },
    { path: "config/tools.json", description: "Tool registry — which tools are eager/disabled, tool-specific settings", agentEditable: true },
    { path: "config/protected-files.json", description: "List of core files the agent cannot modify", agentEditable: false },
    { path: "config/app-manifest.json", description: "This file — auto-generated map of the entire app (read-only)", agentEditable: false },
  ];
  // Scan for additional config files
  try {
    for (const file of readdirSync(CONFIG_DIR)) {
      if (!configs.some(c => c.path === `config/${file}`)) {
        configs.push({ path: `config/${file}`, description: `Config file: ${file}`, agentEditable: true });
      }
    }
  } catch {}
  return configs;
}

// ── Generator ──

export function generateManifest(): AppManifest {
  const manifest: AppManifest = {
    generatedAt: new Date().toISOString(),
    pages: scanPages(),
    settingsTabs: scanSettingsTabs(),
    agentTabs: scanAgentTabs(),
    apiRoutes: scanApiRoutes(),
    tools: scanTools(),
    apps: scanApps(),
    configFiles: scanConfigFiles(),
    bridges: ["WhatsApp", "Telegram"],
    integrations: ["Google (Gmail, Calendar, Drive, YouTube)", "GitHub", "Slack", "Discord", "Twitter/X", "Facebook", "Instagram", "Spotify", "eBay", "Notion", "Email (SMTP)"],
  };
  return manifest;
}

export function writeManifest(): void {
  const manifest = generateManifest();
  try {
    writeFileSync(MANIFEST_PATH, JSON.stringify(manifest, null, 2));
    console.log(`[manifest] Generated app-manifest.json (${manifest.pages.length} pages, ${manifest.apiRoutes.length} routes, ${manifest.tools.length} tools, ${manifest.apps.length} apps)`);
  } catch (e) {
    console.warn("[manifest] Failed to write app-manifest.json:", (e as Error).message);
  }
}

/** Build a concise text summary of the manifest for injection into the system prompt. */
export function getManifestSummary(): string {
  let manifest: AppManifest;
  try {
    manifest = JSON.parse(readFileSync(MANIFEST_PATH, "utf-8"));
  } catch {
    return "";
  }

  // Resolve APP_URL so the agent gets a real URL, not a placeholder
  let appUrl = "http://127.0.0.1:7007";
  try {
    const { getRuntimeConfig } = require("./config.js");
    const rc = getRuntimeConfig();
    appUrl = `http://127.0.0.1:${rc.port}`;
  } catch {}

  const lines: string[] = [
    "## App Map (what you have — use this before building anything new)",
    "",
    "### Pages",
    ...manifest.pages.map(p => `- **${p.name}** (${p.path}) — ${p.description}`),
    "",
    "### Settings Tabs (accessible via Settings page)",
    ...manifest.settingsTabs.map(t => `- **${t.name}** — ${t.description}`),
    "",
    "### Agents Page Tabs",
    ...manifest.agentTabs.map(t => `- **${t.name}** — ${t.description}`),
    "",
    "### Built Apps",
    ...(manifest.apps.length > 0
      ? manifest.apps.map(a => `- **${a.name}** (${a.path}/) — ${a.files.length} files`)
      : ["- No apps built yet"]),
    "",
    "### Bridges",
    ...manifest.bridges.map(b => `- ${b}`),
    "",
    "### Integrations Available",
    ...manifest.integrations.map(i => `- ${i}`),
    "",
    `### Tools: ${manifest.tools.length} total`,
    `Available tools include: ${manifest.tools.slice(0, 30).map(t => t.name).join(", ")}${manifest.tools.length > 30 ? `, and ${manifest.tools.length - 30} more (use tool_search)` : ""}`,
    "",
    `### API Routes: ${manifest.apiRoutes.length} endpoints`,
    "Use these to interact with the app programmatically via http_request.",
    "",
    "### Config Files (your safe zone — edit freely)",
    ...manifest.configFiles.filter(c => c.agentEditable).map(c => `- \`${c.path}\` — ${c.description}`),
    "",
    "### Three Lanes — ALWAYS pick the right one",
    "",
    "**Lane 1: CONTROL THE APP AT RUNTIME → use API routes via `http_request`**",
    "For anything the user can do in the UI — settings, theme, creating orgs, spawning agents, connecting bridges.",
    "The API changes server-side state. The user's browser updates immediately (via WebSocket push or next load).",
    "NEVER use the `browser` tool to interact with your own app — that opens a separate browser the user can't see.",
    "",
    "**Lane 2: CHANGE YOURSELF → edit config/ files**",
    "For changing how you think, behave, or what tools you have.",
    "Edit files in `config/` directly with `read` + `edit`. Changes hot-reload — no restart needed.",
    "",
    "**Lane 3: EXTERNAL WEBSITES → use `browser` tool**",
    "For Google, Amazon, social media, any site that isn't this app.",
    "ONLY use `browser` for sites outside {{APP_URL}}.",
    "",
    "### Common Operations",
    "- **Change theme**: `http_request` → `POST {{APP_URL}}/api/settings` with `{\"theme\": \"light\"}` (or `\"dark\"`, `\"system\"`)",
    "- **Change any setting**: `http_request` → `POST {{APP_URL}}/api/settings` with the setting JSON",
    "- **Change AI provider/model**: `http_request` → `POST {{APP_URL}}/api/providers/switch` with `{\"provider\": \"...\", \"model\": \"...\"}`",
    "- **Create an organization**: `http_request` → `POST {{APP_URL}}/api/agents/organizations` — uses existing Agents page Org Chart tab",
    "- **Spawn agents**: use `agent_spawn` tool (calls API internally)",
    "- **Connect WhatsApp**: `http_request` → `POST {{APP_URL}}/api/whatsapp/connect`",
    "- **Connect Telegram**: `http_request` → `POST {{APP_URL}}/api/telegram/connect`",
    "- **Schedule recurring tasks**: `http_request` → `POST {{APP_URL}}/api/cron`",
    "- **Build a standalone app**: use `build_app` tool — creates in `workspace/apps/{name}/`",
    "- **Pin a page to sidebar**: `http_request` POST {{APP_URL}}/api/sidebar/pins body `{\"name\":\"...\",\"icon\":\"📌\",\"url\":\"/page.html\"}`",
    "- **Unpin from sidebar**: `http_request` DELETE {{APP_URL}}/api/sidebar/pins/PageName",
    "- **Change system prompt**: `read` + `edit` on `config/system-prompt.md` (hot-reloads)",
    "- **Add/remove tools**: `read` + `edit` on `config/tools.json`",
    "",
    "**IMPORTANT**: Before creating anything new, check this map. If it already exists, USE the existing feature via its API route.",
  ];

  return lines.join("\n").replace(/\{\{APP_URL\}\}/g, appUrl);
}

// ── Hot-reload watcher ──

let _manifestWatching = false;

export function startManifestWatcher(): void {
  if (_manifestWatching) return;

  const watchDirs = [
    join(ROOT, "public"),
    join(ROOT, "src", "routes"),
    join(ROOT, "workspace", "apps"),
    CONFIG_DIR,
  ];

  for (const dir of watchDirs) {
    if (!existsSync(dir)) continue;
    try {
      let debounce: NodeJS.Timeout | null = null;
      watch(dir, { recursive: true }, (_event, filename) => {
        // Skip changes to app-manifest.json itself to prevent infinite regeneration loop
        if (filename && filename.toString().includes("app-manifest")) return;
        // Debounce: regenerate at most once per 5 seconds
        if (debounce) clearTimeout(debounce);
        debounce = setTimeout(() => {
          writeManifest();
        }, 5000);
      });
    } catch {}
  }
  _manifestWatching = true;
  console.log("[manifest] Watching for changes (public/, src/routes/, workspace/apps/, config/)");
}
