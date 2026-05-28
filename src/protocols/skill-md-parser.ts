/**
 * SKILL.md → Protocol parser.
 *
 * SKILL.md is the upstream community/Anthropic format for prompt-style
 * workflows: YAML frontmatter (name, description, when-to-use, argument-hint,
 * allowed-tools, license, tags, category) followed by a markdown body.
 *
 * This module reads a SKILL.md file's text + source metadata and produces a
 * Protocol record. The body is preserved verbatim — `protocol_get` returns
 * it as the executable instruction text. steps[]/rules[]/learnablePreferences[]
 * are intentionally empty for prompt-style protocols; that's how the loader
 * distinguishes them from typed packs.
 *
 * No external YAML dep — the frontmatter shape is restricted enough that a
 * 30-line key/value+list parser handles every case in the upstream corpus.
 */

import type { Protocol, ProtocolSource } from "../protocols/index.js";

interface Frontmatter {
  meta: Record<string, string | string[]>;
  body: string;
}

/** Lifted from the legacy skill-loader; same shape, same edge cases.
 *  Normalizes CRLF before matching so the per-line YAML pass isn't broken
 *  by Windows line endings on imported content. */
function parseFrontmatter(content: string): Frontmatter {
  content = content.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const match = content.match(/^---\s*\n([\s\S]*?)\n---\s*\n([\s\S]*)$/);
  if (!match) return { meta: {}, body: content };

  const meta: Record<string, string | string[]> = {};
  let currentKey = "";
  for (const line of match[1].split("\n")) {
    const kvMatch = line.match(/^(\w[\w-]*):\s*(.*)$/);
    if (kvMatch) {
      currentKey = kvMatch[1];
      const val = kvMatch[2].trim();
      if (val.startsWith("[") && val.endsWith("]")) {
        meta[currentKey] = val.slice(1, -1).split(",").map((s) => s.trim()).filter(Boolean);
      } else if (val) {
        meta[currentKey] = val.replace(/^["']|["']$/g, "");
      }
    } else if (currentKey && line.match(/^\s+-\s+(.+)/)) {
      const item = line.match(/^\s+-\s+(.+)/)?.[1]?.trim();
      if (item) {
        const existing = meta[currentKey];
        if (Array.isArray(existing)) existing.push(item);
        else meta[currentKey] = [item];
      }
    }
  }
  return { meta, body: match[2].trim() };
}

const CATEGORY_MAP: Record<string, string> = {
  instagram: "Social Media", twitter: "Social Media", facebook: "Social Media",
  tiktok: "Social Media", linkedin: "Social Media", x_post: "Social Media",
  git: "Developer", deploy: "Developer", test: "Developer", pr: "Developer",
  docker: "Developer", kubernetes: "Developer", build: "Developer",
  research: "Research", summarize: "Research", search: "Research", scrape: "Research",
  email: "Communication", slack: "Communication", discord: "Communication",
  whatsapp: "Communication", sms: "Communication", call: "Communication",
  smart: "Smart Home", light: "Smart Home", thermostat: "Smart Home",
  doc: "Documents", pdf: "Documents", docx: "Documents", spreadsheet: "Documents",
};

function deriveCategory(name: string, explicit?: string): string {
  if (explicit && typeof explicit === "string") return explicit;
  const lower = name.toLowerCase();
  for (const [key, cat] of Object.entries(CATEGORY_MAP)) {
    if (lower.includes(key)) return cat;
  }
  return "General";
}

function asArray(v: unknown): string[] | undefined {
  if (Array.isArray(v)) return v.map((x) => String(x));
  if (typeof v === "string") return [v];
  return undefined;
}

function asString(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined;
}

export interface ParseSkillMdOpts {
  /** Provenance — where this SKILL.md came from. */
  source: ProtocolSource;
  /** If frontmatter omits `name`, fall back to this (typically the directory name). */
  fallbackName?: string;
}

/**
 * Parse a SKILL.md text into a Protocol record. Returns null only if there's
 * no usable name AND no body; partial frontmatter is tolerated everywhere else.
 */
export function parseSkillMd(text: string, opts: ParseSkillMdOpts): Protocol | null {
  const { meta, body } = parseFrontmatter(text);
  const name = asString(meta.name) || opts.fallbackName;
  if (!name) return null;
  if (!body && !asString(meta.description)) return null;

  const description = asString(meta.description) || `Protocol: ${name}`;
  const triggers = asArray(meta.triggers) ?? asArray(meta["when-to-use"]) ?? [name];
  const allowedTools = asArray(meta["allowed-tools"]) ?? asArray(meta.allowedTools);
  const tags = asArray(meta.tags);
  const category = deriveCategory(name, asString(meta.category));

  // License resolution: frontmatter wins over source-level. The importer
  // pre-validates this; the runtime parser still records what's there.
  const license = asString(meta.license) || opts.source.license;
  const source: ProtocolSource = { ...opts.source, license };

  return {
    name,
    description,
    triggers,
    steps: [],                 // prompt-style: body carries the instructions
    rules: [],                 // typed packs use these; SKILL.md does not
    learnablePreferences: [],
    body,
    allowedTools,
    source,
    category,
    tags,
  };
}

/** Re-export for callers that want to drive the parser themselves. */
export { parseFrontmatter };
