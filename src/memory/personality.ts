/**
 * Personality files — user profile, agent heart, identity.
 *
 * These markdown files live in the memory dir and are loaded into every
 * system prompt by buildContextBlock. Defaults are written on first run
 * so the agent has something to work from before the user customizes.
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { safeReadTextFile } from "./utils.js";
import { writeMemorySafely } from "./write-safely.js";
import { findContradictions } from "./contradiction-sweep.js";

import { createLogger } from "../logger.js";
const logger = createLogger("memory.personality");
const contradictionLogger = createLogger("memory.contradiction");

export const PERSONALITY_FILES: Record<string, string> = {
  user: "USER.md",         // Who the user is, how they want to be addressed
  heart: "HEART.md",       // Agent personality, behavior config, vibe
  identity: "IDENTITY.md", // Agent name, emoji, catchphrase
};

const DEFAULT_USER_MD = `# About Me

<!-- Edit this file to tell your agent who you are. -->
<!-- The agent will read this at the start of every conversation. -->

- Name:
- Location:
- Job/Role:
- Interests:
- Communication style: (casual / formal / technical / etc.)

## Family & People
<!-- List the people who matter to you so the agent knows them -->

## Current Projects
<!-- What are you working on right now? -->
`;

const DEFAULT_HEART_MD = `# Agent Heart

<!-- This file defines your agent's personality and behavior. -->
<!-- Edit it to shape how your agent talks, thinks, and acts. -->

## Personality Traits
- Warm, genuine, and direct
- Remembers everything and weaves it into conversation naturally
- Celebrates wins, asks follow-ups on things that matter
- Matches the user's energy — casual when they're casual, focused when they're focused

## Communication Style
- Talk like a real friend, not a customer service bot
- Use the user's name naturally
- Reference past conversations: "Didn't you mention..." / "Last time you were working on..."
- Be honest — a real friend tells the truth

## Boundaries
- Never expose internal memory system details (scores, paths, chunks)
- Never make up personal information — search memory first
- Never treat the user like a stranger if you have memories of them

## Special Instructions
<!-- Add any custom rules here -->
`;

const DEFAULT_IDENTITY_MD = `# Agent Identity

<!-- Your agent has no name yet. On first conversation, it will ask you to name it. -->
<!-- Once named, the name and personality are saved here and loaded into every conversation. -->

- Name: (not yet named)
- Emoji:
- Tagline:
- Vibe:
`;

/** Write default personality files if they don't exist yet. */
export function ensurePersonalityFiles(memDir: string): void {
  const defaults: Record<string, string> = {
    [PERSONALITY_FILES.user]: DEFAULT_USER_MD,
    [PERSONALITY_FILES.heart]: DEFAULT_HEART_MD,
    [PERSONALITY_FILES.identity]: DEFAULT_IDENTITY_MD,
  };

  for (const [filename, content] of Object.entries(defaults)) {
    const filePath = join(memDir, filename);
    if (!existsSync(filePath)) {
      writeMemorySafely({
        content,
        source: "personality",
        target: filePath,
        mode: "overwrite",
      });
    }
  }
}

/**
 * Read a personality file, stripping HTML comments and running a taint check.
 * Returns null if missing, empty, or tainted (would be a prompt-injection risk).
 */
export async function readPersonalityFile(
  memDir: string,
  key: string
): Promise<string | null> {
  if (!PERSONALITY_FILES[key]) return null;
  const filePath = join(memDir, PERSONALITY_FILES[key]);
  if (!existsSync(filePath)) return null;
  const content = safeReadTextFile(filePath);
  if (!content || !content.trim()) return null;

  const cleaned = content.replace(/<!--[\s\S]*?-->/g, "").trim() || null;
  if (!cleaned) return null;

  // Taint-check: profile files load into every system prompt, so a poisoned
  // IDENTITY.md / HEART.md / USER.md = permanent hijack.
  try {
    const { checkMemoryTaint } = await import("../sanitize.js");
    const taint = checkMemoryTaint(cleaned);
    if (!taint.safe) {
      logger.warn(`[memory] Profile file ${key} failed taint check: ${taint.reason} — skipping`);
      return null;
    }
  } catch {}

  return cleaned;
}

// ── Dedupe ──
//
// Profile files (USER.md / IDENTITY.md / HEART.md / MIND.md) used to drift
// into stacked-duplicate-block corruption: every memory_update_profile
// `append` of a fresh About Me / Agent Identity block left the older one
// in place. The model then saw multiple `Name:` lines in <user_profile>
// and either re-asked or addressed the user by a stale value.
//
// This collapses duplicates by canonical top-level heading. Within a
// heading group, scalar `- Field: value` lines latest-non-empty-wins
// (so a corrected name overwrites the old one, but a later empty value
// doesn't wipe a real earlier one), and `##` subsections latest-wins.
// Insertion order is preserved by the first occurrence of each heading.
export function dedupeProfileMarkdown(content: string): string {
  if (!content || !content.trim()) return content;
  const lines = content.split("\n");

  // No fast-path. Even files with a single top-level heading can have
  // duplicate subsections + scalar bullets piled up from append-style
  // writes — we run the full normalize on every save so the file
  // self-heals instead of accumulating contradictions.
  const TOP_HEADING = /^#\s+(.+?)\s*$/;
  const SUB_HEADING = /^##\s+(.+?)\s*$/;
  const SCALAR = /^-\s+([^:\n]+?):\s*(.*)$/;

  // Normalize the two specific garbage patterns we've seen in real
  // corruption: stacked "## ## Heading" and same-name "## Foo## Foo".
  // Apply repeatedly until stable so triple-stacked cases also resolve.
  const normalizeHeadingLine = (line: string): string => {
    let prev = "";
    let cur = line;
    while (cur !== prev) {
      prev = cur;
      cur = cur
        .replace(/^##(?:\s+##)+\s+(.+)$/, "## $1")
        .replace(/^##\s+([^#]+?)##\s+\1\s*$/, "## $1")
        .replace(/^##\s+([^#]+?)##\s+.+$/, "## $1");
    }
    return cur;
  };

  interface Block {
    rawHeadingLine: string;
    scalarOrder: string[];
    scalars: Map<string, string>;
    subOrder: string[];
    subs: Map<string, { rawHeadingLine: string; body: string[] }>;
  }

  const groups = new Map<string, Block>();
  const groupOrder: string[] = [];
  const preamble: string[] = [];

  let currentBlock: Block | null = null;
  let currentSub: { rawHeadingLine: string; body: string[] } | null = null;

  const flushSub = () => {
    if (!currentBlock || !currentSub) return;
    const key = currentSub.rawHeadingLine.trim();
    if (!currentBlock.subOrder.includes(key)) currentBlock.subOrder.push(key);
    // Latest-wins: a later occurrence of the same subheading overwrites.
    currentBlock.subs.set(key, currentSub);
    currentSub = null;
  };

  for (const line of lines) {
    const top = line.match(TOP_HEADING);
    if (top) {
      flushSub();
      const key = top[1].trim().toLowerCase();
      let block = groups.get(key);
      if (!block) {
        block = {
          rawHeadingLine: line,
          scalarOrder: [],
          scalars: new Map(),
          subOrder: [],
          subs: new Map(),
        };
        groups.set(key, block);
        groupOrder.push(key);
      }
      currentBlock = block;
      continue;
    }
    if (!currentBlock) {
      preamble.push(line);
      continue;
    }
    const normalizedHeading = normalizeHeadingLine(line);
    const sub = normalizedHeading.match(SUB_HEADING);
    if (sub) {
      flushSub();
      currentSub = { rawHeadingLine: `## ${sub[1].trim()}`, body: [] };
      continue;
    }
    if (currentSub) {
      currentSub.body.push(line);
      continue;
    }
    const scalar = line.match(SCALAR);
    if (scalar) {
      const field = scalar[1].trim();
      const value = scalar[2].trim();
      if (!currentBlock.scalarOrder.includes(field)) {
        currentBlock.scalarOrder.push(field);
      }
      const prior = currentBlock.scalars.get(field);
      // Latest non-empty wins. Empty value only sticks if no prior value.
      if (value || prior === undefined || !prior.trim()) {
        currentBlock.scalars.set(field, value);
      }
      continue;
    }
    // Blank / comment / freeform line in the scalar zone — drop on dedupe.
    // (HTML comments are stripped by the reader anyway; blank lines are
    // re-inserted on emit.)
  }
  flushSub();

  const out: string[] = [];
  for (const line of preamble) out.push(line);
  for (const key of groupOrder) {
    const b = groups.get(key)!;
    if (out.length && out[out.length - 1].trim() !== "") out.push("");
    out.push(b.rawHeadingLine);
    if (b.scalarOrder.length) {
      out.push("");
      for (const field of b.scalarOrder) {
        const v = b.scalars.get(field) ?? "";
        // Don't pad an empty value with a trailing space — keeps clean
        // input round-tripping cleanly through dedupe.
        out.push(v ? `- ${field}: ${v}` : `- ${field}:`);
      }
    }
    for (const subKey of b.subOrder) {
      const sub = b.subs.get(subKey);
      if (!sub) continue;
      // Avoid stacking two blank lines between consecutive empty-bodied
      // subheadings — input "## A\n\n## B\n" round-trips cleanly.
      if (out.length && out[out.length - 1].trim() !== "") out.push("");
      out.push(sub.rawHeadingLine);
      for (const bl of sub.body) out.push(bl);
    }
  }
  while (out.length && out[out.length - 1].trim() === "") out.pop();

  // Cross-section contradiction sweep. The block-level dedupe above merges
  // duplicate headings and overwrites scalar fields, but it can't catch a
  // semantically-contradicting bullet that lives under a different section
  // heading (real example: HEART.md had "Always greet in Spanish" under
  // `## Language Preference` while `## Greeting Style` said "No Spanish
  // greetings" — different section, same topic, opposite polarity). The
  // sweep walks every `- bullet` across all sections, flags pairs that
  // overlap heavily AND differ in polarity, and strips the affirmative
  // side. Negation wins because corrections to durable rules are
  // overwhelmingly phrased as retractions of an earlier instruction.
  const finalLines = sweepBulletContradictions(out);
  return finalLines.join("\n") + "\n";
}

function sweepBulletContradictions(lines: string[]): string[] {
  const bullets: Array<{ text: string; payload: number }> = [];
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^\s*-\s+(.+?)\s*$/);
    if (!m) continue;
    // Skip scalar fields ("- Name: Alex") — those are handled by the
    // latest-wins logic above. Contradiction sweep is for prose bullets
    // (instructions / rules), not key-value entries.
    if (/^[^:]{1,40}:/.test(m[1])) continue;
    bullets.push({ text: m[1], payload: i });
  }
  if (bullets.length < 2) return lines;

  const pairs = findContradictions(bullets);
  if (pairs.length === 0) return lines;

  const toDrop = new Set<number>();
  for (const p of pairs) {
    toDrop.add(p.drop);
    contradictionLogger.warn(
      `[contradiction] profile: dropped "${lines[p.drop].trim().slice(0, 80)}" ` +
      `(contradicts "${lines[p.keep].trim().slice(0, 80)}", overlap=${p.overlap.toFixed(2)})`,
    );
  }
  return lines.filter((_, i) => !toDrop.has(i));
}

// Set or update a scalar bullet in USER.md ("- Name: Alex").
//
// Resolution order:
//   1. If a "- <Field>: ..." line already exists anywhere in the file
//      (case-insensitive), rewrite its value in place. First occurrence
//      wins; dedupe later collapses any trailing duplicates.
//   2. If no such line exists, append it under the first top-level
//      heading (usually "# About Me"). Boilerplate "<!-- … -->" comment
//      blocks stay where they are.
//   3. If the file has no top-level heading at all, prepend a minimal
//      "# About Me" block and add the field.
//
// Empty value clears the field — the bullet stays but the value goes
// blank, so the next read knows the slot exists but is undeclared.
export function setUserScalarField(existing: string, field: string, value: string): string {
  const fieldDisplay = field.trim();
  const valueClean = value.trim();
  const SCALAR = /^(-\s+)([^:\n]+?)(\s*:\s*)(.*)$/;

  if (existing && existing.trim()) {
    const lines = existing.split("\n");
    for (let i = 0; i < lines.length; i++) {
      const m = lines[i].match(SCALAR);
      if (!m) continue;
      if (m[2].trim().toLowerCase() === fieldDisplay.toLowerCase()) {
        // Preserve the existing label's casing — "Name" stays "Name" even
        // if the caller passed "name". Avoids label churn on case drift.
        const existingLabel = m[2].trim();
        lines[i] = `${m[1]}${existingLabel}${m[3]}${valueClean}`;
        return lines.join("\n");
      }
    }
    // No existing bullet for this field — insert one after the first
    // top-level heading. If we can't find one, fall through to fresh-file
    // path below.
    const headingIdx = lines.findIndex((l) => /^#\s+/.test(l));
    if (headingIdx >= 0) {
      // Find the first non-comment, non-blank line after the heading to
      // anchor the insertion. We want the bullet to sit with other
      // scalars when they exist, not floating between heading and an
      // HTML comment block.
      let insertAt = headingIdx + 1;
      let firstBulletIdx = -1;
      for (let i = headingIdx + 1; i < lines.length; i++) {
        if (/^#{1,6}\s/.test(lines[i])) break;
        if (SCALAR.test(lines[i])) { firstBulletIdx = i; break; }
      }
      if (firstBulletIdx >= 0) insertAt = firstBulletIdx;
      lines.splice(insertAt, 0, `- ${fieldDisplay}: ${valueClean}`);
      return lines.join("\n");
    }
  }

  // Fresh file or no heading found — minimal valid structure.
  return `# About Me\n\n- ${fieldDisplay}: ${valueClean}\n`;
}
