import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

import { MANIFEST_PATH } from "./paths.js";
import type { AppManifest } from "./types.js";
import { FLIPPABLE_SETTINGS, SPENDING_CAP_SETTINGS } from "../settings-schema.js";
import { AGENT_DENIED_ROUTES } from "../rbac-agent-denials.js";

/**
 * Security-settings line for the App Map — DERIVED from the settings
 * registry, never hand-typed. A hand-typed copy omitted
 * enableComputerControl and a blocked agent went hunting for a nonexistent
 * toggle endpoint (2026-07-20). Exported for the contract test.
 */
export function securitySettingsLine(): string {
  const fields = FLIPPABLE_SETTINGS.filter((s) => s.owner === "protected").map((s) => s.field).join("/");
  return (
    `- **Security settings** (${fields}) and **spending caps** (${[...SPENDING_CAP_SETTINGS].join("/")}): when the user asks you to change one, use the \`setting\` tool with that field. ` +
    `A change that only narrows what you may do or spend (a capability off, a cap lowered) applies at once; one that widens it asks the user to approve first. ` +
    `That IS how you turn a capability back on at the user's request. Just don't widen one unless the user explicitly asked, ` +
    `and never silently re-enable one to get around a block.`
  );
}

/**
 * The controls only the user changes, DERIVED from the routes the agent is
 * refused. Without it the agent told a user asking to turn the shell sandbox
 * off that LAX "doesn't have a single sandbox mode switch" (2026-10-03).
 */
export function userOnlyControlsLine(): string {
  const places = [...new Set(AGENT_DENIED_ROUTES.flatMap((r) => (r.place ? [r.place] : [])))];
  const named = places.map((p) => `${p.split(" → ").pop()} (${p})`).join("; ");
  return `- **The user's alone through the UI** (no API route of yours changes these): ${named}. Where a dedicated tool exists, it may act on the user's explicit request — \`setting\` for a security field the user asks you to change (widening asks them to confirm), \`request_secret\` for a secret, \`mcp_add_server\` for an MCP server. Without one, say it is theirs to change and where, and do not look for another way.`;
}

const require = createRequire(import.meta.url);

/** Build a concise text summary of the manifest for injection into the system prompt. */
export function getManifestSummary(): string {
  let manifest: AppManifest;
  try {
    manifest = JSON.parse(readFileSync(MANIFEST_PATH, "utf-8"));
  } catch {
    return "";
  }
  return summarizeManifest(manifest);
}

/** The App Map text for `manifest`. */
export function summarizeManifest(manifest: AppManifest): string {

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
    "### Built Apps (each in workspace/apps/<name>/)",
    ...builtAppLines(manifest.apps),
    "",
    "### Bridges",
    ...manifest.bridges.map(b => `- ${b}`),
    "",
    "### Integrations Available",
    ...manifest.integrations.map(i => `- ${i}`),
    "",
    // A count and the way in, not names: the model already holds the tools it
    // was given, and 30 names in scan order cost ~150 tokens on every turn.
    `### Tools: ${manifest.tools.length} total`,
    "The ones not already loaded are found with tool_search.",
    "",
    `### API Routes: ${manifest.apiRoutes.length} endpoints — call via http_request when no dedicated tool fits`,
    ...summarizeRoutesByResource(manifest.apiRoutes),
    "",
    "NEVER drive your own app ({{APP_URL}}) with the `browser` tool — use `setting`, the dedicated tools and your API routes instead. The three lanes (setting tool / self_edit / browser) are in your Invariants.",
    "",
    "### Common Operations",
    "- **Change an app setting** (theme, provider, model, temperature, reasoning effort, …): the `setting` tool with that field. It checks the value, applies it, and updates every open window",
    securitySettingsLine(),
    userOnlyControlsLine(),
    "- **Create a project**: use `project_create` tool (name + optional agent_ids); list with `project_list`; add members with `project_add_agent`",
    "- **Spawn agents**: use `agent_spawn` tool (calls API internally)",
    "- **Connect WhatsApp**: `http_request` → `POST {{APP_URL}}/api/whatsapp/connect`",
    "- **Connect Telegram**: `http_request` → `POST {{APP_URL}}/api/telegram/connect`",
    "- **Schedule recurring tasks**: the `mission_schedule_create` tool (list/update/toggle/delete siblings)",
    "- **Build a standalone app**: `build_app` sets up `workspace/apps/{name}/` and returns the brief; write the app yourself, then `app_check`",
    "- **Pin/unpin sidebar**: use `sidebar_pin` / `sidebar_unpin` tools",
    "- **Clear sidebar Conversations list**: use `sidebar_clear` (removes them from the lists on every device; every chat stays on disk and in memory)",
    "- **Turn a tool family on or off**: the `setting` tool (`enableShell`, `enableHttp`, `enableBrowser`, `enableComputerControl`)",
    "",
    "**IMPORTANT**: Before creating anything new, check this map. If it already exists, USE the existing feature via its API route.",
  ];

  return lines.join("\n").replace(/\{\{APP_URL\}\}/g, appUrl);
}

/** How many built apps the App Map names; the rest are a count and a pointer. */
export const APP_MAP_APPS_SHOWN = 10;

/** The App Map rides every turn, so it cannot grow with the user's apps: at
 *  141 apps their list was ~10k characters, and on a local 65k window it
 *  pushed the "How to work" rules out of the prompt (rule-coverage.test.ts).
 *  The most recently changed are named, once each (the folder follows from
 *  the name); `app_list` has every one. */
export function builtAppLines(apps: AppManifest["apps"]): string[] {
  if (apps.length === 0) return ["- No apps built yet"];
  const newest = [...apps].sort((a, b) => (b.modifiedMs ?? 0) - (a.modifiedMs ?? 0)).slice(0, APP_MAP_APPS_SHOWN);
  const rest = apps.length - newest.length;
  const names = newest.map(a => a.name).join(", ");
  return [rest > 0
    ? `- Most recently changed: ${names}; and ${rest} more. \`app_list\` lists every app`
    : `- ${names}`];
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
