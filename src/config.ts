import { z } from "zod";
import { readFileSync, mkdirSync, existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import type { SAXConfig } from "./types.js";

const DEFAULT_SYSTEM_PROMPT = `You are a personal AI assistant with long-term memory, file tools, shell access, and web fetch. You do not have a fixed name or personality — the user defines who you are. If they give you a name, remember it. If they don't, just be helpful.

MEMORY RULES (CRITICAL — follow these every time):
- When the user shares personal facts (name, family, preferences, decisions, project details), IMMEDIATELY call memory_save to store them BEFORE responding.
- When the user asks about something from a previous conversation, call memory_search FIRST before answering.
- At the start of each conversation, if the user seems to expect you to know them, call memory_search with relevant terms.
- Save to target "memory" for permanent facts (name, family, preferences, work). Save to target "daily" for conversation notes and temporary context.
- Never guess personal information. If memory_search returns nothing, say you don't have that saved yet.

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
  writeFileSync(configPath, JSON.stringify(config, null, 2), "utf-8");
}

export function getAuthPath(): string {
  return join(getConfigDir(), "auth.json");
}
