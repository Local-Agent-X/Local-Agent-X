/**
 * Settings source-of-truth schema.
 *
 * Single registry of every field the UI (or the agent) can flip through
 * /api/settings. POST /api/settings refuses a field that is not declared
 * here, so a key exists only once it has an entry saying who owns it. Each
 * entry says:
 *   - what valid values look like (zod)
 *   - who may change it (owner), and where the user does when it is not the agent
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
 *
 * The entries live in one table per domain (settings-schema.controls.ts,
 * .preferences.ts, .operator.ts); this module merges them and derives the
 * sets every consumer reads.
 */
import type { z } from "zod";
import type { LAXConfig } from "./types.js";
import { CONTROL_SETTINGS } from "./settings-schema.controls.js";
import { PREFERENCE_SETTINGS } from "./settings-schema.preferences.js";
import { OPERATOR_SETTINGS } from "./settings-schema.operator.js";

/**
 * Who may change a setting. There is no default: an entry that does not say
 * is a compile error, so a new key is never writable by the agent by accident.
 *   agent        — the agent may set it itself (`setting` tool, or its own
 *                  POST /api/settings), as may the user.
 *   protected    — a user-owned security control. The agent may narrow it
 *                  (settings-change-direction.ts); widening it takes the user's
 *                  approval (tool-execution/protected-setting-gate.ts).
 *   spending-cap — the user's money, held to the same rule as `protected`.
 *   operator     — only the user's own Settings page (a request carrying the
 *                  operator token): each hands the agent authority.
 */
export type SettingOwner = "agent" | "protected" | "spending-cap" | "operator";

/** The owner, plus where in the app the user changes a setting the agent may not. */
export type SettingOwnership =
  | { owner: "agent" }
  | { owner: Exclude<SettingOwner, "agent">; where: string };

export type FlippableSetting = SettingOwnership & {
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
};

export const FLIPPABLE_SETTINGS: ReadonlyArray<FlippableSetting> = [
  ...CONTROL_SETTINGS,
  ...PREFERENCE_SETTINGS,
  ...OPERATOR_SETTINGS,
];

const BY_FIELD: ReadonlyMap<string, FlippableSetting> = new Map(FLIPPABLE_SETTINGS.map((s) => [s.field, s]));

/** The declaration for `field`, or undefined when settings.json has no such setting. */
export function settingSpec(field: string): FlippableSetting | undefined {
  return BY_FIELD.get(field);
}

const fieldsOwnedBy = (owner: SettingOwner): ReadonlySet<string> =>
  new Set(FLIPPABLE_SETTINGS.filter((s) => s.owner === owner).map((s) => s.field));

/**
 * Why the agent may not change `fields` itself, naming where the user does, or
 * null when none of them is operator-owned. Neither its own POST
 * /api/settings nor the `setting` tool can apply an operator setting.
 */
export function operatorOnlyRefusal(fields: readonly string[]): string | null {
  const owned = fields.map(settingSpec).filter((s): s is FlippableSetting & { where: string } => s?.owner === "operator");
  if (owned.length === 0) return null;
  const places = [...new Set(owned.map((s) => s.where))].join("; ");
  return `Only the user can change ${owned.map((s) => s.field).join(", ")} (${places}). Ask them to do it there.`;
}

/** Subset that needs config.json mirroring + GET overlay. */
export const RUNTIME_SETTINGS: ReadonlyArray<FlippableSetting> = FLIPPABLE_SETTINGS.filter((s) => s.runtime);

/** Fields that trigger a WS broadcast on change (cross-tab UI sync). */
export const BROADCAST_KEYS: ReadonlySet<string> = new Set(
  FLIPPABLE_SETTINGS.filter((s) => s.broadcast).map((s) => s.field),
);

/** User-owned security controls the agent can request but never self-apply. */
export const PROTECTED_SETTINGS: ReadonlySet<string> = fieldsOwnedBy("protected");

/** True when a field is a user-owned security control (see PROTECTED_SETTINGS). */
export function isProtectedSetting(field: string): boolean {
  return PROTECTED_SETTINGS.has(field);
}

/** The spending caps, each in USD, where 0 (or a missing per-model entry) means
 *  no cap. User-owned like the protected settings (settings-change-direction.ts). */
export const SPENDING_CAP_SETTINGS: ReadonlySet<string> = fieldsOwnedBy("spending-cap");

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
type PublicField = { field: string; owner: SettingOwner; where?: string; type: string; values?: unknown; description: string; runtime: boolean };
export function publicSchema(): PublicField[] {
  return FLIPPABLE_SETTINGS.map((s) => {
    const out: PublicField = {
      field: s.field,
      owner: s.owner,
      ...("where" in s ? { where: s.where } : {}),
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
