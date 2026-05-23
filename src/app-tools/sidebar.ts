/**
 * Sidebar pin tools — pin/unpin apps to the left navigation rail.
 * No registry access; persists directly to ~/.lax/settings.json and
 * broadcasts the new list to connected WS clients.
 */

import type { ToolDefinition } from "../types.js";
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { homedir } from "node:os";
import { ok, err } from "./shared.js";

export const sidebarPin: ToolDefinition = {
  name: "sidebar_pin",
  description:
    "Pin an app or page to the sidebar navigation. Use when the user says 'pin to sidebar', 'add to sidebar', or 'show in sidebar'. Pin the name the user gave as-is — do NOT verify the app exists in workspace/apps/ or anywhere else on the filesystem first; the sidebar is just a navigation entry. If you do need to find the canonical app name first, use app_list (not bash/glob/read). Do NOT use this tool for generic 'add X'/'put X'/'show X'/'use X as background' requests — those are about app content/features, not sidebar navigation.",
  parameters: {
    type: "object",
    properties: {
      name: { type: "string", description: "Display name for the sidebar entry (e.g. 'Calculator')" },
      icon: { type: "string", description: "Emoji icon (e.g. '🧮'). Defaults to '📌'" },
    },
    required: ["name"],
  },
  async execute(args: Record<string, unknown>) {
    const name = String(args.name || "").trim();
    if (!name) return err("name is required");
    const icon = String(args.icon || "📌");

    // Resolve the app URL — check workspace/apps/ for a matching folder
    const dataDir = join(homedir(), ".lax");
    const workspaceApps = resolve("workspace", "apps");
    const slug = name.toLowerCase().replace(/\s+/g, "-");

    let pageUrl = "";
    if (existsSync(resolve(workspaceApps, slug, "index.html"))) {
      pageUrl = `/apps/${slug}/`;
    } else {
      // Fuzzy match against available apps
      try {
        const dirs = readdirSync(workspaceApps).filter(d => existsSync(resolve(workspaceApps, d, "index.html")));
        const match = dirs.find(d => d === slug || d.includes(slug) || slug.includes(d));
        if (match) {
          pageUrl = `/apps/${match}/`;
        } else if (dirs.length > 0) {
          return err(`No app found matching "${name}". Available: ${dirs.join(", ")}`);
        } else {
          return err(`No apps found in workspace.`);
        }
      } catch {
        return err(`Could not read workspace apps directory.`);
      }
    }

    // Read/write settings.json
    const settingsPath = join(dataDir, "settings.json");
    let settings: Record<string, unknown> = {};
    try { if (existsSync(settingsPath)) settings = JSON.parse(readFileSync(settingsPath, "utf-8")); } catch {}
    const pins = (settings.sidebarPins || []) as Array<{ name: string; icon: string; url: string }>;

    if (pins.length >= 10 && !pins.some(p => p.name === name)) {
      return err("Maximum 10 pinned apps. Unpin one first.");
    }
    if (pins.some(p => p.name === name)) {
      return ok(`${name} is already pinned to the sidebar.`);
    }

    pins.push({ name, icon, url: pageUrl });
    settings.sidebarPins = pins;
    writeFileSync(settingsPath, JSON.stringify(settings, null, 2), { encoding: "utf-8", mode: 0o600 });

    // Notify connected clients
    try { const { broadcastAll } = await import("../chat-ws.js"); broadcastAll({ type: "sidebar_pins_changed", pins }); } catch {}

    return ok(`Pinned ${icon} ${name} to the sidebar.`);
  },
};

export const sidebarUnpin: ToolDefinition = {
  name: "sidebar_unpin",
  description:
    "Remove an app or page from the sidebar navigation. ONLY use when the user explicitly says 'unpin from sidebar', 'remove from sidebar', 'hide from sidebar', or 'take off sidebar'. Do NOT use for generic 'remove X'/'hide X'/'delete X' requests — those are about app content/features, not sidebar navigation.",
  parameters: {
    type: "object",
    properties: {
      name: { type: "string", description: "Name of the sidebar entry to remove, or 'all' to clear everything" },
    },
    required: ["name"],
  },
  async execute(args: Record<string, unknown>) {
    const name = String(args.name || "").trim();
    if (!name) return err("name is required");

    const dataDir = join(homedir(), ".lax");
    const settingsPath = join(dataDir, "settings.json");
    let settings: Record<string, unknown> = {};
    try { if (existsSync(settingsPath)) settings = JSON.parse(readFileSync(settingsPath, "utf-8")); } catch {}
    const currentPins = (settings.sidebarPins || []) as Array<{ name: string }>;

    if (name.toLowerCase() === "all") {
      if (currentPins.length === 0) return ok("Sidebar is already empty.");
      const removed = currentPins.map(p => p.name).join(", ");
      settings.sidebarPins = [];
      writeFileSync(settingsPath, JSON.stringify(settings, null, 2), { encoding: "utf-8", mode: 0o600 });
      try { const { broadcastAll } = await import("../chat-ws.js"); broadcastAll({ type: "sidebar_pins_changed", pins: [] }); } catch {}
      return ok(`Removed all pins from the sidebar: ${removed}`);
    }

    // Case-insensitive match
    const pins = currentPins.filter(p => p.name.toLowerCase() !== name.toLowerCase());
    if (pins.length === currentPins.length) {
      const available = currentPins.map(p => p.name).join(", ");
      return err(`"${name}" is not pinned. Current pins: ${available || "none"}`);
    }

    settings.sidebarPins = pins;
    writeFileSync(settingsPath, JSON.stringify(settings, null, 2), { encoding: "utf-8", mode: 0o600 });

    try { const { broadcastAll } = await import("../chat-ws.js"); broadcastAll({ type: "sidebar_pins_changed", pins }); } catch {}

    return ok(`Removed ${name} from the sidebar.`);
  },
};
