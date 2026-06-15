import type { ToolDefinition, ToolResult } from "../types.js";
import { checkForUpdate, applyUpdateNow } from "../update-service.js";
import { desktopBridgeAvailable, desktopRelaunchApp } from "../desktop-bridge.js";
import { writeRestartNotice, resolveNotifyTarget } from "../restart-notify.js";
import { recentlyDone, markDone } from "./idempotency.js";

const APPLY_COOLDOWN_MS = 120_000;
// Let the "applied, relaunching" reply deliver before the app goes down.
const RELAUNCH_DELAY_MS = 4_000;

export const checkForUpdates: ToolDefinition = {
  name: "check_for_updates",
  description:
    "Check whether a newer version of Local Agent X is available (compares this " +
    "install to the latest on the main branch). READ-ONLY — installs nothing. " +
    "Reports whether an update is available, the version/commit, and the latest " +
    "change summary. If one is available, ask the user before calling apply_update.",
  parameters: { type: "object", properties: {}, required: [] },
  async execute(): Promise<ToolResult> {
    const r = await checkForUpdate();
    if (r.error) return { content: `Couldn't check for updates: ${r.error}`, isError: true };
    if (!r.updateAvailable) {
      return { content: `You're up to date (version ${r.localVersion}${r.localCommit ? `, ${r.localCommit}` : ""}).`, metadata: { updateAvailable: false } };
    }
    return {
      content:
        `Update available: ${r.remoteCommit || r.remoteVersion}` +
        `${r.releaseNotes ? ` — "${r.releaseNotes}"` : ""} (you're on ${r.localCommit || r.localVersion}). ` +
        `Want me to download, apply, and restart?`,
      metadata: { updateAvailable: true, remoteCommit: r.remoteCommit, releaseNotes: r.releaseNotes },
    };
  },
};

export const applyUpdate: ToolDefinition = {
  name: "apply_update",
  description:
    "Download, validate (sandbox build/boot/smoke-test), and apply the available " +
    "Local Agent X update, then relaunch the app to finish — messaging you when " +
    "it's back up. Run ONLY after the user confirms. Only works in the desktop " +
    "app. If validation fails, nothing is applied and the reason is reported. " +
    "Check first with check_for_updates.",
  parameters: { type: "object", properties: {}, required: [] },
  async execute(args: Record<string, unknown>): Promise<ToolResult> {
    if (!desktopBridgeAvailable()) {
      return { content: "Can't apply an update here: not running under the desktop app (the relaunch step needs it). Update from Settings → Updates in the app, or restart manually after pulling.", isError: true };
    }
    if (recentlyDone("apply_update", "global", APPLY_COOLDOWN_MS)) {
      return { content: "An update was just applied moments ago — skipping to avoid a loop.", isError: true };
    }
    const target = await resolveNotifyTarget(args);
    if (!target) {
      return { content: "I can update, but no messaging channel is connected to ping you back when it relaunches. Connect Telegram or WhatsApp first (or update from the app).", isError: true };
    }

    // Blocks for minutes: download → sandbox deps/build/bind/smoke → swap. The
    // live install is never touched until the candidate passes validation.
    const result = await applyUpdateNow();
    if (!result.ok) {
      const why = result.held ? "another update or self-edit is in progress" : result.detail;
      return { content: `Update not applied — ${why}. Nothing changed; your install is untouched.`, isError: true };
    }

    markDone("apply_update", "global", `${result.fromCommit}->${result.toCommit}`);
    const now = Date.now();
    // 5-min deadline: a full relaunch + post-update rebuild can be slow.
    writeRestartNotice({ channel: target.channel, target: target.target, reason: `update to ${result.toCommit}`, requestedAt: now, deadlineMs: now + 300_000 });
    // FULL relaunch (not just a server-child restart): an update can include
    // desktop/ (Electron-main) changes a child restart can't reload.
    setTimeout(() => { desktopRelaunchApp(); }, RELAUNCH_DELAY_MS);
    return { content: `Update applied and validated (${result.fromCommit} → ${result.toCommit}). Relaunching now — I'll message you on ${target.channel} when it's back up (a relaunch + rebuild can take a minute or two).` };
  },
};

export const updateTools: ToolDefinition[] = [checkForUpdates, applyUpdate];
