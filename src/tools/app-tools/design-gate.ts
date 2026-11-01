/**
 * Design gate — the house design system reaches an app's UI BEFORE its first
 * file is written, not after.
 *
 * build_app puts the design system into the builder's prompt. An agent that
 * writes index.html straight into workspace/apps/<id>/ (the system prompt's own
 * route for a sidebar app) used to get it from a post-write nudge instead: the
 * file landed off-spec, then the agent was told to rewrite it. Measured
 * 2026-10-16 on a 33 KB paper-trading page — two full rewrites, about six of
 * the twelve minutes the build took.
 *
 * Two doors, one record:
 *   - `app_design_brief` — the agent asks for the system before writing (the
 *     system prompt says to). Costs nothing on a turn that builds no app.
 *   - the write gate (checkAppWrite) — the first UI file written into an app in a
 *     session that has not seen the system is refused, and the refusal CARRIES
 *     the system, so the next attempt lands. Code enforces what the prompt
 *     asks for; an agent without the tool still cannot write past it.
 * build_app records its own delivery, since its builder already has the text.
 *
 * Create vs update follows build_app's rule: an archetype brief only for a new
 * app (empty or missing directory). An existing app gets the craft rules and
 * anti-patterns and keeps its own look.
 *
 * The record is in-memory, per session and app: a restart or a new chat means
 * the agent sees the system again before writing, which is the point.
 * Disable with LAX_APP_DESIGN_GUARD=0.
 */
import { existsSync } from "node:fs";
import type { ToolDefinition } from "../../types.js";
import { sessionIdOf } from "../../workspace/paths.js";
import {
  selectDesignBrief, DESIGN_CRAFT, DESIGN_TECHNIQUES, DESIGN_ANTI_PATTERNS,
} from "../design-brief.js";
import { ok, err } from "./shared.js";
import { appFolderIsNew, appIdOf, appRootForSession, describeAppRoot } from "./app-root.js";

/** Files whose content IS the visual design. A .md/.json/.ts write carries no
 *  look and passes the gate. */
const DESIGN_EXT_RE = /\.(html?|css|jsx|tsx|vue|svelte)$/i;

/** Backstop on sessions tracked; the oldest is dropped past it. */
const MAX_SESSIONS = 500;

const delivered = new Map<string, Set<string>>();

const sessionKey = (sessionId: string | undefined): string => sessionId || "default";
const appKey = (appId: string): string => appId.toLowerCase();

export function markDesignDelivered(sessionId: string | undefined, appId: string): void {
  const key = sessionKey(sessionId);
  let apps = delivered.get(key);
  if (!apps) {
    if (delivered.size >= MAX_SESSIONS) {
      const oldest = delivered.keys().next().value;
      if (oldest !== undefined) delivered.delete(oldest);
    }
    apps = new Set();
    delivered.set(key, apps);
  }
  apps.add(appKey(appId));
}

export function designDelivered(sessionId: string | undefined, appId: string): boolean {
  return delivered.get(sessionKey(sessionId))?.has(appKey(appId)) ?? false;
}

/** Test seam: forget every delivery. */
export function resetDesignDeliveries(): void {
  delivered.clear();
}

/** The design system text for one app. `describe` classifies a new app's
 *  archetype; an existing app gets no archetype, as build_app does on update. */
export function renderAppDesignSystem(appRoot: string, describe: string): string {
  const brief = appFolderIsNew(appRoot)
    ? selectDesignBrief(describe).brief
    : "This app already exists: keep its current look (colors, type, layout) and apply the rules below to what you change.";
  return [brief, DESIGN_CRAFT, DESIGN_TECHNIQUES, DESIGN_ANTI_PATTERNS].join("\n\n");
}

/**
 * The refusal for a UI write the session has not been given the design system
 * for, or null when the write may proceed. A refusal records the delivery: its
 * message IS the system, so the retry passes.
 */
export function designGateRejection(
  appRoot: string,
  appId: string,
  filePath: string,
  content: string,
  sessionId: string | undefined,
  opts: {
    /** Only a project with no files yet is held for the system: its first draft is the one to land on-spec. */
    newProjectOnly?: boolean;
    /** A targeted edit (edit, edit_lines, multi_edit) of a file that exists: it
     *  keeps the file's look, so it is never held. A whole-file write still is.
     *  Refusing one cost a round for a one-token cache-bust (`v=7` → `v=8`,
     *  after a restart emptied the in-memory record, 2026-11-01). */
    edit?: boolean;
  } = {},
): string | null {
  if (process.env.LAX_APP_DESIGN_GUARD === "0") return null;
  if (!DESIGN_EXT_RE.test(filePath)) return null;
  if (opts.edit && existsSync(filePath)) return null;
  if (designDelivered(sessionId, appId)) return null;
  if (opts.newProjectOnly && !appFolderIsNew(appRoot)) return null;
  const system = renderAppDesignSystem(appRoot, content);
  markDesignDelivered(sessionId, appId);
  return (
    `Write rejected: this is the first UI file for app "${appId}" in this conversation, and the house design system ` +
    `had not been loaded for it. Nothing was written. Here it is: write the file again following it. ` +
    `Next time call app_design_brief before writing app UI, so the first draft already follows it.\n\n${system}`
  );
}

export const appDesignBrief: ToolDefinition = {
  name: "app_design_brief",
  effect: { class: "read-only" },
  description:
    "Get the house design system for the app you are about to write UI files for (index.html, CSS, components): " +
    "this session's project folder (the folder a code session is bound to, or the app this chat builds), or an app under workspace/apps/ named by `app`. " +
    "Call it once per app per conversation, before the first write; the first UI write to a new app that hasn't had it is rejected. " +
    "build_app applies it itself, so this is for apps you write directly.",
  parameters: {
    type: "object",
    properties: {
      app: { type: "string", description: "The app's folder name under workspace/apps/ (e.g. 'coinbase-paper-bot'). Omit when this session already has a project folder: that folder is the app." },
      description: { type: "string", description: "What the app is, in a sentence (e.g. 'crypto paper-trading dashboard with an equity chart and a trade log'). Picks the design archetype for a new app." },
    },
    required: ["description"],
  },
  async execute(args: Record<string, unknown>) {
    const app = String(args.app || "").trim() || undefined;
    if (app && /[\\/]|^\.\.?$/.test(app)) return err("app must be a folder name under workspace/apps/, with no slashes");
    const root = appRootForSession(app, sessionIdOf(args));
    if (!root) return err("Name the app: this session has no project folder yet, so pass its folder name under workspace/apps/.");
    const system = renderAppDesignSystem(root, String(args.description || ""));
    markDesignDelivered(sessionIdOf(args), appIdOf(root));
    return ok(`DESIGN SYSTEM for ${describeAppRoot(root)}/ — follow it in every UI file you write for this app.\n\n${system}`);
  },
};
