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
    "### Common Operations (how to do things users ask for)",
    "- **Change theme to light/dark**: edit `public/js/shared.js`, change default on line with `|| 'dark'` to `|| 'light'` (or vice versa). Also change `data-theme` default in `public/js/shared.js`.",
    "- **Change settings**: use `POST /api/settings` with JSON body, or edit `~/.sax/config.json`",
    "- **Change AI provider/model**: `POST /api/providers/switch` with `{provider, model}`",
    "- **Create an organization**: use the existing Agents page → Org Chart tab. Don't build a new org system.",
    "- **Add a new tool**: create a tool definition in `config/tools/` and register it (safe zone)",
    "- **Change system prompt**: edit `config/system-prompt.md` directly (hot-reloads)",
    "- **Build an app**: use `build_app` tool — it creates in `workspace/apps/{name}/`",
    "- **Connect WhatsApp/Telegram**: use the Communication settings tab or API routes",
    "- **Spawn agents**: use `agent_spawn` tool or the Agents page Team tab",
    "- **Schedule recurring tasks**: use cron/missions via `POST /api/cron`",
    "",
    "**IMPORTANT**: Before creating anything new, check this map. If it already exists, use it. If you need to change settings, use the Settings API routes. If you need to modify your own behavior, edit config/ files.",
  ];

  return lines.join("\n");
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
      watch(dir, { recursive: true }, () => {
        // Debounce: regenerate at most once per 2 seconds
        if (debounce) clearTimeout(debounce);
        debounce = setTimeout(() => {
          writeManifest();
        }, 2000);
      });
    } catch {}
  }
  _manifestWatching = true;
  console.log("[manifest] Watching for changes (public/, src/routes/, workspace/apps/, config/)");
}
