/**
 * Sidebar pin tools — pin/unpin apps to the left navigation rail.
 * No registry access; persists directly to ~/.lax/settings.json and
 * broadcasts the new list to connected WS clients.
 */

import type { ToolDefinition } from "../../types.js";
import { existsSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { ok, err } from "./shared.js";
import { workspacePath } from "../../config.js";
import { reloadSettings, saveSettings } from "../../settings.js";

// One loose-match rule shared by pin (app-folder lookup) and unpin (pin
// lookup): equal, or either side contains the other, case-insensitively. Both
// tools must use the SAME predicate — they drifted before (pin matched loosely,
// unpin required an exact name), so a partial reference could miss a pin stored
// under a longer name and wrongly report it wasn't pinned.
export function looseNameMatch(a: string, b: string): boolean {
  const x = a.toLowerCase();
  const y = b.toLowerCase();
  return x === y || x.includes(y) || y.includes(x);
}

export type UnpinResolution =
  | { kind: "match"; name: string }
  | { kind: "ambiguous"; candidates: string[] }
  | { kind: "none" };

// Exact (case-insensitive) match wins, so a precise name removes exactly that
// pin even when a longer pin also contains it. Only when nothing matches
// exactly do we fall back to the forgiving substring match.
export function resolvePinToUnpin(pinNames: string[], query: string): UnpinResolution {
  const q = query.trim();
  const exact = pinNames.find((n) => n.toLowerCase() === q.toLowerCase());
  if (exact) return { kind: "match", name: exact };
  const fuzzy = pinNames.filter((n) => looseNameMatch(n, q));
  if (fuzzy.length === 1) return { kind: "match", name: fuzzy[0] };
  if (fuzzy.length > 1) return { kind: "ambiguous", candidates: fuzzy };
  return { kind: "none" };
}

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
    const workspaceApps = workspacePath("apps");
    const slug = name.toLowerCase().replace(/\s+/g, "-");

    let pageUrl = "";
    if (existsSync(resolve(workspaceApps, slug, "index.html"))) {
      pageUrl = `/apps/${slug}/`;
    } else {
      // Fuzzy match against available apps
      try {
        const dirs = readdirSync(workspaceApps).filter(d => existsSync(resolve(workspaceApps, d, "index.html")));
        const match = dirs.find(d => looseNameMatch(d, slug));
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

    // Read/write settings.json via the canonical seam. reloadSettings() gives
    // a fresh whole-object disk read; saveSettings() atomically rewrites the
    // WHOLE object (mode 0600) AND updates the in-memory cache, so /api/apps
    // (the mobile's icon source, which reads loadSettings()) sees the new pin
    // without a restart — no trailing reloadSettings() needed.
    const settings = reloadSettings();
    const pins = (settings.sidebarPins || []) as Array<{ name: string; icon: string; url: string }>;

    if (pins.length >= 10 && !pins.some(p => p.name === name)) {
      return err("Maximum 10 pinned apps. Unpin one first.");
    }
    if (pins.some(p => p.name === name)) {
      return ok(`${name} is already pinned to the sidebar.`);
    }

    pins.push({ name, icon, url: pageUrl });
    settings.sidebarPins = pins;
    saveSettings(settings);

    // Notify connected clients
    try { const { broadcastAll } = await import("../../chat-ws/index.js"); broadcastAll({ type: "sidebar_pins_changed", pins }); } catch {}

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

    const settings = reloadSettings();
    const currentPins = (settings.sidebarPins || []) as Array<{ name: string }>;

    if (name.toLowerCase() === "all") {
      if (currentPins.length === 0) return ok("Sidebar is already empty.");
      const removed = currentPins.map(p => p.name).join(", ");
      settings.sidebarPins = [];
      saveSettings(settings);
      try { const { broadcastAll } = await import("../../chat-ws/index.js"); broadcastAll({ type: "sidebar_pins_changed", pins: [] }); } catch {}
      return ok(`Removed all pins from the sidebar: ${removed}`);
    }

    // Resolve the reference the same forgiving way sidebar_pin does, so a
    // partial name still finds a pin stored under a longer one.
    const resolution = resolvePinToUnpin(currentPins.map(p => p.name), name);

    if (resolution.kind === "none") {
      // Already-gone is success, not an error — the desired end state holds, and
      // an err() here reads as "try again" to weaker models, which looped them
      // re-unpinning a finished removal.
      const available = currentPins.map(p => p.name).join(", ");
      return ok(`${name} is already not pinned — nothing to do. Current pins: ${available || "none"}`);
    }

    if (resolution.kind === "ambiguous") {
      return ok(`"${name}" matches more than one pin: ${resolution.candidates.join(", ")}. Tell me the exact name to unpin.`);
    }

    const targetName = resolution.name;
    const pins = currentPins.filter(p => p.name !== targetName);
    settings.sidebarPins = pins;
    saveSettings(settings);

    try { const { broadcastAll } = await import("../../chat-ws/index.js"); broadcastAll({ type: "sidebar_pins_changed", pins }); } catch {}

    // Remaining pins in the result so the model has the post-state inline —
    // no reason left to "verify" with a follow-up GET /api/sidebar/pins.
    return ok(`Removed ${targetName} from the sidebar. Remaining pins: ${pins.map(p => p.name).join(", ") || "none"}`);
  },
};

// Hides every chat from the sidebar (frontend-only) without touching the
// backend session store. The model can't reach localStorage directly; this
// tool broadcasts a WS event and the browser tombstones every chat ID it
// holds, then clears `chats[]`. Backend `.jsonl` session files are
// untouched — recoverable by clearing tombstones later. Use ONLY when the
// user explicitly asks to clear, hide, or empty the sidebar conversations
// list. Do NOT call `http_request DELETE /api/sessions` for this — that
// wipes backend data and still doesn't clear the sidebar (the sidebar
// reads from localStorage + tombstones, not the backend list directly).
export const sidebarClear: ToolDefinition = {
  name: "sidebar_clear",
  description:
    "Hide ALL chats from the sidebar's CONVERSATIONS section without deleting the underlying session data on disk. ONLY use when the user explicitly references conversations / chats / chat history (e.g. 'clear my chat history from the sidebar', 'hide all my conversations', 'clear the conversations list', 'wipe sidebar chat history'). The sidebar has FOUR distinct sections — Pinned apps, Projects, Messaging (WhatsApp/Telegram), and Conversations — and this tool ONLY affects Conversations. If the user says something ambiguous like 'clear the sidebar', 'empty the sidebar', or 'reset the sidebar' without naming a section, ASK them which section they mean before calling any tool. For app pins use sidebar_unpin. Never call this when the user is talking about pins, projects, or messaging.",
  parameters: {
    type: "object",
    properties: {},
  },
  async execute() {
    try {
      const { broadcastAll } = await import("../../chat-ws/index.js");
      broadcastAll({ type: "sidebar_clear_chats", at: Date.now() });
    } catch (e) {
      return err(`Failed to broadcast sidebar clear: ${String((e as Error)?.message || e)}`);
    }
    return ok("Sent sidebar-clear signal to the browser. The Conversations list will empty on next render; backend session files are untouched.");
  },
};
