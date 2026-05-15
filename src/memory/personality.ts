/**
 * Personality files — user profile, agent heart/identity, mind.
 *
 * These markdown files live in the memory dir and are loaded into every
 * system prompt by buildContextBlock. Defaults are written on first run
 * so the agent has something to work from before the user customizes.
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { safeReadTextFile } from "./utils.js";
import { writeMemorySafely } from "./write-safely.js";

import { createLogger } from "../logger.js";
const logger = createLogger("memory.personality");

export const PERSONALITY_FILES: Record<string, string> = {
  user: "USER.md",         // Who the user is, how they want to be addressed
  heart: "HEART.md",       // Agent personality, behavior config, vibe
  identity: "IDENTITY.md", // Agent name, emoji, catchphrase
  memory: "MIND.md",       // Core facts and curated knowledge
  mind: "MIND.md",         // Alias — agent can say "mind" or "memory"
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
