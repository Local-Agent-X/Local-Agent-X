import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

import { MANIFEST_PATH } from "./paths.js";
import type { AppManifest } from "./types.js";

const require = createRequire(import.meta.url);

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
    const { getRuntimeConfig } = require("../config.js");
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
    `### API Routes: ${manifest.apiRoutes.length} endpoints — call via http_request when no dedicated tool fits`,
    ...summarizeRoutesByResource(manifest.apiRoutes),
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
    "- **Change a non-security setting** (theme, model, temperature, etc.): `http_request` → `POST {{APP_URL}}/api/settings` with the setting JSON",
    "- **Security settings** (enableShell/enableHttp/enableBrowser, toolApproval): when the user asks you to change one, use the `setting` tool with that field — it takes effect immediately. That IS how you turn a capability back on at the user's request. Just don't change a security setting unless the user explicitly asked, and never silently re-enable one to get around a block.",
    "- **Change AI provider/model**: `http_request` → `POST {{APP_URL}}/api/providers/switch` with `{\"provider\": \"...\", \"model\": \"...\"}`",
    "- **Create an organization**: `http_request` → `POST {{APP_URL}}/api/agents/organizations` — uses existing Agents page Org Chart tab",
    "- **Create a project**: use `project_create` tool (name + optional agent_ids); list with `project_list`; add members with `project_add_agent`",
    "- **Spawn agents**: use `agent_spawn` tool (calls API internally)",
    "- **Connect WhatsApp**: `http_request` → `POST {{APP_URL}}/api/whatsapp/connect`",
    "- **Connect Telegram**: `http_request` → `POST {{APP_URL}}/api/telegram/connect`",
    "- **Schedule recurring tasks**: `http_request` → `POST {{APP_URL}}/api/cron`",
    "- **Build a standalone app**: use `build_app` tool — creates in `workspace/apps/{name}/`",
    "- **Pin/unpin sidebar**: use `sidebar_pin` / `sidebar_unpin` tools",
    "- **Clear sidebar Conversations list**: use `sidebar_clear` (frontend-only; do NOT call `http_request DELETE /api/sessions` — that destroys backend session data)",
    "- **Change system prompt**: `read` + `edit` on `config/system-prompt.md` (hot-reloads)",
    "- **Add/remove tools**: `read` + `edit` on `config/tools.json`",
    "",
    "**IMPORTANT**: Before creating anything new, check this map. If it already exists, USE the existing feature via its API route.",
  ];

  return lines.join("\n").replace(/\{\{APP_URL\}\}/g, appUrl);
}

/** Group API routes by their first /api/<resource> segment and emit one
 *  line per resource so the agent can discover endpoints without dumping
 *  all 200+ rows. Each line lists distinct methods + path tails; long
 *  tails are truncated so a chatty resource doesn't blow the budget. */
function summarizeRoutesByResource(routes: AppManifest["apiRoutes"]): string[] {
  const byResource = new Map<string, { method: string; tail: string }[]>();
  for (const r of routes) {
    const match = r.path.match(/^\/api\/([^/]+)(\/.*)?$/);
    if (!match) continue;
    const resource = match[1];
    const tail = match[2] || "";
    const list = byResource.get(resource) || [];
    list.push({ method: r.method, tail });
    byResource.set(resource, list);
  }
  const resources = Array.from(byResource.keys()).sort();
  const lines = resources.map((resource) => {
    const entries = byResource.get(resource)!;
    const seen = new Set<string>();
    const compact: string[] = [];
    for (const e of entries) {
      const key = `${e.method} ${e.tail}`;
      if (seen.has(key)) continue;
      seen.add(key);
      compact.push(e.tail ? `${e.method}${e.tail}` : e.method);
      if (compact.length >= 6) { compact.push("…"); break; }
    }
    return `- \`/api/${resource}\` — ${compact.join(", ")}`;
  });
  return lines;
}
