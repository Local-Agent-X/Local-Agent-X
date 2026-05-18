/**
 * App Manifest Generator — scans the codebase and produces config/app-manifest.json.
 *
 * This gives the agent a complete map of its own app: every page, tab, route,
 * setting, tool, and capability. The agent reads this to know what already exists
 * so it doesn't rebuild things and knows where to make changes.
 *
 * Runs at startup and hot-reloads when source files change.
 */

import { readFileSync, writeFileSync, existsSync, readdirSync, statSync, watch } from "node:fs";
import { join, resolve } from "node:path";

import { createLogger } from "./logger.js";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const logger = createLogger("manifest-generator");

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
  // The SPA in public/app.html serves at "/" and has built-in sections for
  // chat, settings, secrets, etc. — those aren't separate URLs. Only list
  // truly standalone HTML files that the SPA doesn't internalize.
  const pages: PageEntry[] = [
    { name: "Chat", path: "/", description: "Main app SPA — chat, settings, secrets, apps panel all live inside" },
  ];
  const publicDir = join(ROOT, "public");
  try {
    for (const file of readdirSync(publicDir)) {
      if (file.endsWith(".html") && file !== "app.html") {
        pages.push({ name: file.replace(".html", ""), path: `/${file}`, description: `Standalone page: ${file}` });
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
  const routes: RouteEntry[] = [];
  const seen = new Set<string>();

  const add = (method: string, path: string, description?: string) => {
    const key = `${method} ${path}`;
    if (seen.has(key)) return;
    seen.add(key);
    routes.push({ method, path, description: description || `${method} ${path}` });
  };

  const walk = (dir: string): void => {
    let entries: string[];
    try { entries = readdirSync(dir); } catch { return; }
    for (const entry of entries) {
      const full = join(dir, entry);
      let isDir = false;
      try { isDir = statSync(full).isDirectory(); } catch { continue; }
      if (isDir) { walk(full); continue; }
      if (!entry.endsWith(".ts") || entry.endsWith(".test.ts")) continue;
      scanRouteFile(full, add);
    }
  };

  walk(join(ROOT, "src", "routes"));

  // server.ts may register routes via Express-style .METHOD("/path", handler).
  try {
    const serverContent = readFileSync(join(ROOT, "src", "server.ts"), "utf-8");
    const expressRegex = /\.(get|post|put|patch|delete)\s*\(\s*["'`](\/[^"'`]*)["'`]/gi;
    let m;
    while ((m = expressRegex.exec(serverContent)) !== null) {
      add(m[1].toUpperCase(), m[2]);
    }
  } catch {}

  routes.sort((a, b) => a.path.localeCompare(b.path) || a.method.localeCompare(b.method));
  return routes;
}

// Routes in this codebase are dispatched by guards like:
//   if (method === "GET" && url.pathname === "/api/foo") { ... }
//   if (method === "POST" && url.pathname.match(/^\/api\/foo\/[^/]+$/)) { ... }
//   if (method === "GET" && url.pathname.startsWith("/api/foo/")) { ... }
// We pair each method check on a line with the pathname comparison on the same line.
function scanRouteFile(file: string, add: (m: string, p: string, d?: string) => void): void {
  let content: string;
  try { content = readFileSync(file, "utf-8"); } catch { return; }

  for (const line of content.split("\n")) {
    const methodMatch = line.match(/method\s*===\s*["'](GET|POST|PUT|PATCH|DELETE)["']/);
    if (!methodMatch) continue;
    const method = methodMatch[1];

    const exact = line.match(/url\.pathname\s*===\s*["'`](\/[^"'`]*)["'`]/);
    if (exact) { add(method, exact[1]); continue; }

    const startsWith = line.match(/url\.pathname\.startsWith\s*\(\s*["'`](\/[^"'`]*)["'`]/);
    if (startsWith) { add(method, `${startsWith[1]}*`); continue; }

    const matchExpr = line.match(/url\.pathname\.match\s*\(\s*\/(.+?)\/[gimsuy]*\s*\)/);
    if (matchExpr) {
      const path = regexSourceToPath(matchExpr[1]);
      if (path) add(method, path);
    }
  }
}

// Convert a route regex source like "^\/api\/agents\/[^/]+$" into "/api/agents/:id".
function regexSourceToPath(src: string): string | null {
  let path = src;
  if (path.startsWith("^")) path = path.slice(1);
  if (path.endsWith("$")) path = path.slice(0, -1);
  path = path.replace(/\\\//g, "/");
  path = path.replace(/\[\^\/\]\+/g, ":id");
  path = path.replace(/\[a-zA-Z0-9_-\]\+/g, ":id");
  path = path.replace(/\([^)]+\)/g, ":id");
  path = path.replace(/\\\?/g, "?");
  if (!path.startsWith("/")) return null;
  return path;
}

function scanTools(): ToolSummary[] {
  const tools: ToolSummary[] = [];
  const toolFiles = ["src/tools.ts", "src/memory/tools.ts", "src/browser-tools.ts", "src/operations/tools.ts", "src/app-tools.ts"];

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
    logger.info(`[manifest] Generated app-manifest.json (${manifest.pages.length} pages, ${manifest.apiRoutes.length} routes, ${manifest.tools.length} tools, ${manifest.apps.length} apps)`);
  } catch (e) {
    logger.warn("[manifest] Failed to write app-manifest.json:", (e as Error).message);
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
    "- **Pin/unpin sidebar**: use `sidebar_pin` / `sidebar_unpin` tools",
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

  const appsDir = join(ROOT, "workspace", "apps");

  for (const dir of watchDirs) {
    if (!existsSync(dir)) continue;
    try {
      let debounce: NodeJS.Timeout | null = null;
      // Per-app debounce so a flurry of edits doesn't re-broadcast 20 reload events
      const appDebounce = new Map<string, NodeJS.Timeout>();
      watch(dir, { recursive: true }, (_event, filename) => {
        if (filename && filename.toString().includes("app-manifest")) return;

        // workspace/apps/<name>/... -> broadcast app-files-changed so any
        // pinned iframe for that app auto-reloads.
        if (dir === appsDir && filename) {
          const rel = filename.toString().replace(/\\/g, "/");
          const appName = rel.split("/")[0];
          if (appName && appName !== "." && !appName.startsWith(".")) {
            const existing = appDebounce.get(appName);
            if (existing) clearTimeout(existing);
            appDebounce.set(appName, setTimeout(() => {
              appDebounce.delete(appName);
              import("./chat-ws.js").then(({ broadcastAll }) => {
                try { broadcastAll({ type: "app-files-changed", appName }); }
                catch (e) { logger.warn(`[manifest] app-files-changed broadcast failed: ${(e as Error).message}`); }
              }).catch(() => {});
            }, 400));
          }
        }

        if (debounce) clearTimeout(debounce);
        debounce = setTimeout(() => {
          writeManifest();
        }, 5000);
      });
    } catch {}
  }
  _manifestWatching = true;
  logger.info("[manifest] Watching for changes (public/, src/routes/, workspace/apps/, config/)");
}
