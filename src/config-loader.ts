/**
 * Config Loader — reads config files from config/ directory and hot-reloads on change.
 *
 * The config/ directory is the "safe zone" — the agent can freely modify these files.
 * The src/ core reads from here but never gets modified by the agent.
 *
 * Files:
 *   config/system-prompt.md     — base system prompt (agent-editable)
 *   config/protected-files.json — list of files agent cannot modify (self-protecting)
 *   config/tools.json           — tool registry settings (eager/deferred/disabled)
 */

import { readFileSync, existsSync, watch } from "node:fs";
import { handleWatcherErrors } from "./util/watcher-errors.js";
import { join, resolve, normalize, isAbsolute, relative } from "node:path";

import { createLogger } from "./logger.js";
import type { PromptPriority, PromptSection } from "./context/system-prompt-builder.js";
const logger = createLogger("config-loader");

const CONFIG_DIR = resolve(join(import.meta.dirname || ".", "..", "config"));

// The platform's own install/repo root — the parent of config/. Self-protection
// is anchored HERE: only files inside this tree can be protected. Without the
// anchor, entries like "src/index.ts" / "src/types.ts" / "src/config.ts" matched
// by path-suffix and wrongly blocked a model from editing an unrelated user
// project that happens to use the same (extremely common) filenames.
const PLATFORM_ROOT = resolve(CONFIG_DIR, "..");

// ── Cached values ──

let _systemPrompt: string | null = null;
let _protectedFiles: string[] | null = null;
let _toolsConfig: ToolsConfig | null = null;

interface ToolsConfig {
  eager: string[];
  disabled: string[];
  settings: Record<string, Record<string, unknown>>;
}

// ── Readers ──

/** Load the system prompt from config/system-prompt.md. Falls back to empty string. */
export function loadSystemPrompt(): string {
  if (_systemPrompt !== null) return _systemPrompt;
  const path = join(CONFIG_DIR, "system-prompt.md");
  try {
    _systemPrompt = readFileSync(path, "utf-8").trim();
  } catch {
    logger.warn("[config-loader] Could not read config/system-prompt.md — using empty prompt");
    _systemPrompt = "";
  }
  return _systemPrompt;
}

/** One `## ` part of the base prompt. `heading` is "" for text before the first heading. */
export interface SystemPromptPart {
  heading: string;
  text: string;
}

/**
 * Split a prompt at its `## ` headings, in file order. INVARIANT: the parts'
 * `text` joined with "" reproduce the input byte-for-byte — each part keeps
 * its own heading line, line endings and trailing blank lines, and nothing
 * is trimmed. The system-prompt builder relies on that to emit the file as
 * one section per heading (so the local-window budget can shed behaviour
 * tuning before the user's facts) without moving a single byte of the
 * cache-prefix that a single-section base prompt produced.
 */
export function splitSystemPromptSections(prompt: string): SystemPromptPart[] {
  if (!prompt) return [];
  const bounds = [0, ...Array.from(prompt.matchAll(/^## /gm), (match) => match.index), prompt.length];
  const parts: SystemPromptPart[] = [];
  for (let i = 0; i < bounds.length - 1; i++) {
    if (bounds[i] === bounds[i + 1]) continue; // no preamble before the first heading
    const text = prompt.slice(bounds[i], bounds[i + 1]);
    const heading = text.startsWith("## ") ? text.slice(3).split(/\r?\n/, 1)[0].trim() : "";
    parts.push({ heading, text });
  }
  return parts;
}

/** config/system-prompt.md as heading parts; joined, identical to loadSystemPrompt(). */
export function loadSystemPromptSections(): SystemPromptPart[] {
  return splitSystemPromptSections(loadSystemPrompt());
}

// Budget class per base-prompt part, keyed by the heading's slug (text up to
// the first " (", " — " or " - ", lower-cased, non-alphanumerics collapsed to
// "-"). The allocator (context/prompt-degradation.ts) sheds tuning first,
// then navigation, then facts; safety and identity are never shed. A heading
// missing here is tuning — the safe default for prose an agent added to its
// own prompt — and is logged once so the omission is visible, not silent.
const BASE_PROMPT_PART_CLASS: Readonly<Record<string, PromptPriority>> = {
  "preamble": "identity", // "You are a personal AI companion …" before the first heading
  "core-rules": "safety",
  "workspace-security": "safety",
  "identity": "identity",
  "personality": "identity",
  "how-to-control-your-own-app": "navigation",
  "apps-pages": "navigation",
  "memory": "navigation", // "Memory — relational …" is the recall behaviour, not the facts
  "background-operations": "navigation",
  "how-to-work": "tuning",
  "coding-discipline": "tuning",
  "delegation": "tuning",
  "browser": "tuning",
  "self-modification": "tuning",
  "self-repair-and-self-extension": "tuning",
};
const unclassifiedHeadingsLogged = new Set<string>();

/** Slug + budget class for one base-prompt heading ("" = the preamble). */
export function classifySystemPromptPart(heading: string): { slug: string; priority: PromptPriority } {
  const slug = heading.split(/ \(| — | - /, 1)[0]
    .toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "preamble";
  const known = BASE_PROMPT_PART_CLASS[slug];
  if (known) return { slug, priority: known };
  if (!unclassifiedHeadingsLogged.has(slug)) {
    unclassifiedHeadingsLogged.add(slug);
    logger.warn(`[config-loader] system-prompt.md heading "${heading}" has no budget class — treating as tuning (shed first on small local windows)`);
  }
  return { slug, priority: "tuning" };
}

/**
 * The base prompt as builder sections, one per `## ` part, ids
 * `core-identity/<slug>` in file order (a repeated heading gets `-2`, `-3` …
 * rather than throwing the builder's duplicate-id error over an agent edit).
 * Safety and identity parts are `required`; the rest are `degradable`.
 */
export function basePromptSections(prompt: string): PromptSection[] {
  const ids = new Set<string>();
  return splitSystemPromptSections(prompt).map((part) => {
    const { slug, priority } = classifySystemPromptPart(part.heading);
    let id = `core-identity/${slug}`;
    for (let n = 2; ids.has(id); n++) id = `core-identity/${slug}-${n}`;
    ids.add(id);
    return {
      id, label: part.heading || "System Prompt", type: "static", priority,
      policy: priority === "safety" || priority === "identity" ? "required" : "degradable",
      build: () => part.text,
    };
  });
}

/** Load the protected files list from config/protected-files.json. */
export function loadProtectedFiles(): string[] {
  if (_protectedFiles !== null) return _protectedFiles;
  const path = join(CONFIG_DIR, "protected-files.json");
  try {
    const data = JSON.parse(readFileSync(path, "utf-8"));
    _protectedFiles = (data.protected || []) as string[];
  } catch {
    logger.warn("[config-loader] Could not read config/protected-files.json — no files protected");
    _protectedFiles = [];
  }
  return _protectedFiles;
}

/** Load tool registry config from config/tools.json. */
export function loadToolsConfig(): ToolsConfig {
  if (_toolsConfig !== null) return _toolsConfig;
  const path = join(CONFIG_DIR, "tools.json");
  try {
    const data = JSON.parse(readFileSync(path, "utf-8"));
    _toolsConfig = {
      eager: data.eager || [],
      disabled: data.disabled || [],
      settings: data.settings || {},
    };
  } catch {
    _toolsConfig = { eager: [], disabled: [], settings: {} };
  }
  return _toolsConfig;
}

/**
 * Match a candidate path against a single manifest entry. The candidate is
 * already normalized to forward slashes and may be absolute or repo-relative.
 * A trailing "/" on the entry protects the entire subtree (so splitting a
 * protected file into a directory keeps it protected). Matching is anchored to
 * path-segment boundaries: "src/security/" never matches "src/security-notes.ts"
 * and "src/auth.ts" never matches a file ending in "oauth.ts".
 */
export function pathMatchesProtected(candidate: string, entry: string): boolean {
  const isDir = entry.endsWith("/");
  const e = normalize(entry).replace(/\\/g, "/").replace(/\/+$/, "");
  if (!e) return false;
  // File, or the directory node itself: candidate equals e or ends with "/<e>".
  const atBoundary = candidate === e || candidate.endsWith("/" + e);
  if (!isDir) return atBoundary;
  // Directory subtree: the dir itself, anything under it (".../<e>/..."), or a
  // repo-relative path that starts with "<e>/".
  return atBoundary || candidate.includes("/" + e + "/") || candidate.startsWith(e + "/");
}

/**
 * Check if a file path is protected (cannot be modified by the agent). Only the
 * platform's OWN source under PLATFORM_ROOT is protected — a path in any other
 * project is never protected, even when its repo-relative shape is identical
 * (e.g. a user project's own src/index.ts). A relative path is interpreted
 * against the platform root, because that's where the agent's path resolver
 * lands a bare "src/…" edit; an absolute path must fall inside the tree.
 */
export function isProtectedFile(filePath: string): { protected: boolean; reason?: string } {
  const raw = String(filePath ?? "");
  if (!raw) return { protected: false };

  const abs = isAbsolute(raw) ? normalize(raw) : resolve(PLATFORM_ROOT, raw);
  const rel = relative(PLATFORM_ROOT, abs).replace(/\\/g, "/");
  // Outside the platform tree (../… or a different drive) → another project's
  // file → never protected. This is the anchor the old suffix match lacked.
  if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) return { protected: false };

  const protectedList = loadProtectedFiles();

  // Load reasons
  let reasons: Record<string, string> = {};
  try {
    const path = join(CONFIG_DIR, "protected-files.json");
    const data = JSON.parse(readFileSync(path, "utf-8"));
    reasons = data.reason || {};
  } catch {}

  for (const protectedPath of protectedList) {
    if (pathMatchesProtected(rel, protectedPath)) {
      return {
        protected: true,
        reason: reasons[protectedPath] || `${protectedPath} is a protected core file`,
      };
    }
  }
  return { protected: false };
}

// ── Hot-reload watcher ──

let _watching = false;

/** Start watching config/ for changes and invalidate caches. */
export function startConfigWatcher(): void {
  if (_watching) return;
  if (!existsSync(CONFIG_DIR)) return;

  try {
    handleWatcherErrors(watch(CONFIG_DIR, { recursive: true }, (eventType, filename) => {
      if (!filename) return;
      const name = filename.replace(/\\/g, "/");

      if (name === "system-prompt.md") {
        _systemPrompt = null;
        logger.info("[config-loader] Hot-reloaded system-prompt.md");
      } else if (name === "protected-files.json") {
        _protectedFiles = null;
        logger.info("[config-loader] Hot-reloaded protected-files.json");
      } else if (name === "tools.json") {
        _toolsConfig = null;
        logger.info("[config-loader] Hot-reloaded tools.json");
      }
    }), "config-loader");
    _watching = true;
    logger.info("[config-loader] Watching config/ for changes");
  } catch (e) {
    logger.warn("[config-loader] Could not start file watcher:", (e as Error).message);
  }
}
