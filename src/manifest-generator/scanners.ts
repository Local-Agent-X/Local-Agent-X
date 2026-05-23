import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { ROOT, CONFIG_DIR } from "./paths.js";
import type { PageEntry, TabEntry, ToolSummary, AppEntry, ConfigFileEntry } from "./types.js";

export function scanPages(): PageEntry[] {
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

export function scanSettingsTabs(): TabEntry[] {
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

export function scanAgentTabs(): TabEntry[] {
  return [
    { name: "Team", id: "agents-tab-team", description: "Agent roster — spawn, hire, view status of all agents" },
    { name: "Org Chart", id: "agents-tab-orgchart", description: "Visual hierarchy of agent teams and reporting structure" },
    { name: "Inbox", id: "agents-tab-inbox", description: "Agent proposals and messages awaiting review" },
    { name: "Issues", id: "agents-tab-issues", description: "Issue tracking with status workflow" },
    { name: "Templates", id: "agents-tab-templates", description: "Agent template library for reusable roles" },
    { name: "History", id: "agents-tab-history", description: "Agent run history with filtering by status" },
  ];
}

export function scanTools(): ToolSummary[] {
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

export function scanApps(): AppEntry[] {
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

export function scanConfigFiles(): ConfigFileEntry[] {
  const configs: ConfigFileEntry[] = [
    { path: "config/system-prompt.md", description: "Agent's system prompt — edit to change behavior, personality, rules", agentEditable: true },
    { path: "config/tools.json", description: "Tool registry — which tools are eager/disabled, tool-specific settings", agentEditable: true },
    { path: "config/protected-files.json", description: "List of core files the agent cannot modify", agentEditable: false },
    { path: "config/app-manifest.json", description: "This file — auto-generated map of the entire app (read-only)", agentEditable: false },
  ];
  try {
    for (const file of readdirSync(CONFIG_DIR)) {
      if (!configs.some(c => c.path === `config/${file}`)) {
        configs.push({ path: `config/${file}`, description: `Config file: ${file}`, agentEditable: true });
      }
    }
  } catch {}
  return configs;
}
