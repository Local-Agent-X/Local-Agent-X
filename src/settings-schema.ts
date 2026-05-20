/**
 * Settings source-of-truth schema.
 *
 * Single registry of every field the UI (or the agent) can flip through
 * /api/settings. Each entry says:
 *   - what valid values look like (zod)
 *   - whether the SERVER RUNTIME reads it (runtime: true) — those get
 *     mirrored to config.json + ctx.config on POST, and overlaid live
 *     into the GET response so the UI sees what the runtime actually
 *     uses (not a stale settings.json).
 *   - a short human description for the schema endpoint
 *
 * Before this module, the POST handler had a growing pile of ad-hoc
 * `if (body.foo)` branches that mirrored some runtime fields and missed
 * others (toolApproval 2026-05-19, maxIterations/temperature drift,
 * bridgeVoicePreference GET mismatch). The agent guessing field names
 * (`shellAccess` instead of `enableShell`, 2026-05-19) is the same class
 * of problem from the other side. This schema is the shared answer:
 * iterate it on both the server (mirroring) and the agent (via
 * GET /api/settings/schema for field-name introspection).
 */
import { z } from "zod";
import type { LAXConfig } from "./types.js";

export interface FlippableSetting {
  /** Field name in the POST body and GET response. */
  field: string;
  /** Zod validator. POST values that fail are silently dropped — UI re-syncs on next GET. */
  validate: z.ZodTypeAny;
  /**
   * true = server runtime reads this via getRuntimeConfig() or ctx.config.
   * The POST handler mirrors runtime fields to config.json + ctx.config so
   * the next read sees the new value with no restart. GET overlays the live
   * ctx.config value into the response.
   *
   * false = UI-only / renderer-only (theme, provider picker, embedding choice
   * read by chat dispatch via settings.json directly). Stored in settings.json
   * only.
   */
  runtime: boolean;
  /** Optional WS broadcast on change (cross-tab sync). */
  broadcast?: boolean;
  /** Human-readable for the schema endpoint — used by the agent to pick the right field. */
  description: string;
}

export const FLIPPABLE_SETTINGS: ReadonlyArray<FlippableSetting> = [
  // ── Runtime-bound (server reads, must mirror to config.json) ──
  {
    field: "toolApproval",
    validate: z.enum(["auto", "confirm-risky", "confirm-all"]),
    runtime: true,
    description: "When the AI must ask for permission before running tools. auto=never, confirm-risky=bash/write/edit, confirm-all=every tool",
  },
  {
    field: "browserMode",
    validate: z.enum(["isolated", "attach"]),
    runtime: true,
    description: "Browser session mode. isolated=dedicated agent profile (safer), attach=user's real Chrome profile (requires Chrome closed)",
  },
  {
    field: "bridgeVoicePreference",
    validate: z.enum(["auto", "sovits", "chatterbox", "lite"]),
    runtime: true,
    description: "Preferred TTS engine for Telegram/WhatsApp bridge replies. auto chooses best available",
  },
  {
    field: "maxIterations",
    validate: z.number().int().min(1).max(300),
    runtime: true,
    description: "Max tool calls per chat turn (1-300)",
  },
  {
    field: "temperature",
    validate: z.number().min(0).max(2),
    runtime: true,
    description: "LLM sampling temperature (0-2). Lower=more deterministic",
  },
  {
    field: "enableShell",
    validate: z.boolean(),
    runtime: true,
    broadcast: true,
    description: "Category kill-switch — when false, blocks ALL bash tool calls at pre-dispatch",
  },
  {
    field: "enableHttp",
    validate: z.boolean(),
    runtime: true,
    broadcast: true,
    description: "Category kill-switch — when false, blocks ALL http_request tool calls at pre-dispatch",
  },
  {
    field: "enableBrowser",
    validate: z.boolean(),
    runtime: true,
    broadcast: true,
    description: "Category kill-switch — when false, blocks ALL browser_* tool calls at pre-dispatch",
  },

  // ── UI-only (renderer reads settings.json directly; no runtime mirror needed) ──
  {
    field: "theme",
    validate: z.enum(["light", "dark", "system"]),
    runtime: false,
    broadcast: true,
    description: "Color scheme. system follows OS preference",
  },
  {
    field: "provider",
    validate: z.string().min(1),
    runtime: false,
    broadcast: true,
    description: "LLM provider id (codex, anthropic, xai, gemini, cerebras, ollama, ollama-cloud, local). Switches the model picker",
  },
  {
    field: "model",
    validate: z.string().min(1),
    runtime: false,
    broadcast: true,
    description: "Model name within the chosen provider (gpt-5.5, claude-opus-4-7, grok-4, etc)",
  },
];

/** Subset that needs config.json mirroring + GET overlay. */
export const RUNTIME_SETTINGS: ReadonlyArray<FlippableSetting> = FLIPPABLE_SETTINGS.filter((s) => s.runtime);

/** Fields that trigger a WS broadcast on change (cross-tab UI sync). */
export const BROADCAST_KEYS: ReadonlySet<string> = new Set(
  FLIPPABLE_SETTINGS.filter((s) => s.broadcast).map((s) => s.field),
);

/**
 * One-time migration: if a user's settings.json has a runtime value that
 * config.json doesn't match, copy settings.json → config.json. Fixes installs
 * that hit the silent-drift bug (settings.json had the UI value, config.json
 * had the stale runtime value).
 *
 * Returns true if any field was migrated (caller should saveConfig).
 */
export function migrateRuntimeSettingsFromSettingsJson(
  settings: Record<string, unknown>,
  config: LAXConfig,
): boolean {
  let changed = false;
  for (const field of RUNTIME_SETTINGS) {
    const settingsVal = settings[field.field];
    if (settingsVal === undefined) continue;
    const parsed = field.validate.safeParse(settingsVal);
    if (!parsed.success) continue;
    if ((config as unknown as Record<string, unknown>)[field.field] === parsed.data) continue;
    (config as unknown as Record<string, unknown>)[field.field] = parsed.data;
    changed = true;
  }
  return changed;
}

/** JSON shape returned by GET /api/settings/schema. Used by the agent (and
 *  any other client) to discover valid field names without guessing. */
export function publicSchema(): Array<{ field: string; type: string; values?: unknown; description: string; runtime: boolean }> {
  return FLIPPABLE_SETTINGS.map((s) => {
    const out: { field: string; type: string; values?: unknown; description: string; runtime: boolean } = {
      field: s.field,
      type: "unknown",
      description: s.description,
      runtime: s.runtime,
    };
    // Lightweight type/enum introspection — good enough to guide the agent.
    const def = (s.validate as unknown as { _def?: { typeName?: string; values?: unknown[]; checks?: unknown[] } })._def;
    if (def?.typeName === "ZodEnum" && Array.isArray(def.values)) { out.type = "enum"; out.values = def.values; }
    else if (def?.typeName === "ZodBoolean") { out.type = "boolean"; }
    else if (def?.typeName === "ZodNumber") { out.type = "number"; }
    else if (def?.typeName === "ZodString") { out.type = "string"; }
    return out;
  });
}
