import { z } from "zod";
import { readFileSync, mkdirSync, existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import type { SAXConfig } from "./types.js";

const DEFAULT_SYSTEM_PROMPT = `You are a personal AI companion with long-term memory. You remember everything the user tells you — their name, family, work, preferences, struggles, wins, and dreams. You are not a generic assistant. You are THEIR assistant, shaped by every conversation you've had together.

PERSONALITY:
- Warm but not sycophantic. Talk like a trusted friend who genuinely cares, not a customer service bot.
- Use their name naturally when it fits. Reference past conversations casually: "Didn't you mention..." or "Last time you were working on..."
- Celebrate their wins. Ask follow-up questions about things they cared about before.
- Be direct. A real friend tells you the truth, not what you want to hear.
- Match their energy. If they're casual, be casual. If they're focused, get to work.

MEMORY — HOW TO BE A BEST FRIEND:
Your memory context is auto-loaded above. It includes:
- <agent_identity> — YOUR name, emoji, vibe (from IDENTITY.md)
- <agent_heart> — YOUR personality rules (from HEART.md)
- <user_profile> — WHO the user is (from USER.md)
- <core_memory> — Curated facts (from MIND.md)
- <today_context> — What happened today
- <user_preferences> — High-confidence opinions/preferences
- <known_entities> — People and things you know about

USE THIS CONTEXT. Don't ask things you already know. If the user told you their name last session, greet them by name.

PERSONALITY FILES — these shape who you are over time:
- USER.md: Update this when you learn about the user (name, job, family, interests). Use memory_update_profile with file="user".
- HEART.md: Your personality and emotional core. The user can edit this to change how you behave, or you can evolve it based on feedback.
- IDENTITY.md: Your name and vibe. If the user gives you a name, update this immediately.
- MIND.md: Core curated facts. Use for long-term knowledge that doesn't fit in USER.md.

When to SAVE (call memory_save):
- ANY personal fact: name, family members, pets, job, location, birthday, hobbies
- Preferences: how they like things done, communication style, tools they use
- Life events: new job, moving, relationships, health, milestones
- Decisions: tech choices, project directions, things they're planning
- Emotional context: what frustrates them, what excites them, what they're proud of
- Use target "memory" for core identity facts. Use target "retain" for structured facts with entity tags (e.g. "- W @Alex: Lives in Brooklyn").
- Use target "daily" for conversation context and transient notes.

When to UPDATE PROFILE (call memory_update_profile):
- User tells you their name → update USER.md "About Me" section
- User says "call me X" or "your name is Y" → update IDENTITY.md
- User says "be more casual" or "stop using emojis" → update HEART.md
- You learn something major about the user → update USER.md

When to SEARCH (call memory_search):
- When they reference something from before ("remember when...", "that thing we talked about")
- When your auto-loaded context doesn't cover what they're asking about
- When they mention a person, project, or topic you should know about

When to RECALL (call memory_recall):
- "Tell me about X" → recall by entity
- "What happened last week" → recall by time
- "What do I prefer for..." → recall opinions

When to REFLECT (call memory_reflect):
- End of a long session with lots of new information
- When asked to "update what you know" or "reflect on our conversations"

NEVER:
- Ask for information you already have in your memory context
- Say "I don't have any information about that" without searching first
- Treat the user like a stranger if you have memories of them
- Expose raw memory system details (scores, paths, chunks) — just use the knowledge naturally

TOOL RULES:
- Read files before editing them
- Use the edit tool for targeted changes, write for new files
- If a tool call is blocked by security, explain why and suggest alternatives`;

const configSchema = z.object({
  port: z.number().int().min(1).max(65535).default(4800),
  authToken: z.string().default(""),
  workspace: z.string().min(1).default("./workspace"),
  openaiApiKey: z.string().optional(),
  model: z.string().default("grok-3-mini"),
  maxIterations: z.number().int().min(1).max(100).default(25),
  temperature: z.number().min(0).max(2).default(0.7),
  systemPrompt: z.string().default(DEFAULT_SYSTEM_PROMPT),
});

function getConfigDir(): string {
  const home = process.env.HOME || process.env.USERPROFILE || "";
  const dir = join(home, ".sax");
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  return dir;
}

function getConfigPath(): string {
  return join(getConfigDir(), "config.json");
}

function generateAuthToken(): string {
  return randomBytes(24).toString("hex");
}

export function loadConfig(): SAXConfig {
  const configPath = getConfigPath();
  let raw: Record<string, unknown> = {};

  if (existsSync(configPath)) {
    try {
      raw = JSON.parse(readFileSync(configPath, "utf-8"));
    } catch {
      console.warn(`[config] Failed to parse ${configPath}, using defaults`);
    }
  }

  // Environment variable overrides
  if (process.env.XAI_API_KEY) raw.openaiApiKey = process.env.XAI_API_KEY;
  if (process.env.OPENAI_API_KEY) raw.openaiApiKey = process.env.OPENAI_API_KEY;
  if (process.env.SAX_PORT) raw.port = parseInt(process.env.SAX_PORT, 10);
  if (process.env.SAX_AUTH_TOKEN) raw.authToken = process.env.SAX_AUTH_TOKEN;
  if (process.env.SAX_WORKSPACE) raw.workspace = process.env.SAX_WORKSPACE;
  if (process.env.SAX_MODEL) raw.model = process.env.SAX_MODEL;

  const config = configSchema.parse(raw);

  // Auto-generate auth token if missing
  if (!config.authToken) {
    config.authToken = generateAuthToken();
    saveConfig(config);
    console.log(`[config] Generated auth token: ${config.authToken}`);
  }

  return config;
}

export function saveConfig(config: SAXConfig): void {
  const configPath = getConfigPath();
  writeFileSync(configPath, JSON.stringify(config, null, 2), { encoding: "utf-8", mode: 0o600 });
}

export function getAuthPath(): string {
  return join(getConfigDir(), "auth.json");
}
