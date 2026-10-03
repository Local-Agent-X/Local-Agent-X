/**
 * Which way a change to a user-owned setting moves the agent's leash.
 *
 * Two kinds of setting are the user's to loosen: the protected security
 * controls (settings-schema.ts `protected: true`) and the spending caps, which
 * decide how much of the user's money an API key may spend. The agent may never
 * widen either on its own: the `setting` tool puts the change to the user
 * (tool-execution/protected-setting-gate.ts) and POST /api/settings refuses it
 * without the operator token (routes/settings/preferences.ts).
 *
 * A change that can only narrow what the agent may do or spend needs nobody's
 * yes. The owner's rule is no card that tells him nothing new, and "the agent
 * switched its own shell off" or "the daily cap went from $75 to $20" is not
 * something he has to approve. Anything this module cannot prove narrower,
 * including a value of the wrong type, is treated as a widening.
 */
import { getRuntimeConfig } from "./config.js";
import { FLIPPABLE_SETTINGS, SPENDING_CAP_SETTINGS, isProtectedSetting } from "./settings-schema.js";
import { loadSettings } from "./settings.js";

type Tightening = { safe: unknown } | { stricterLast: readonly string[] };

/**
 * For each protected setting, the change that can only narrow the agent:
 * setting it to `safe` (a kill-switch off, a supervision on), or moving it
 * toward the end of `stricterLast`. Each value is checked against the schema
 * by settings-change-direction.test.ts, so a renamed enum value fails there.
 *
 * browserSecrecy is not ordered: "guarded" withholds secret-bearing pages that
 * "ask" lets the user approve, but "ask" also treats /passwords and /vault
 * paths as secret-bearing where "guarded" does not, so neither contains the
 * other. Only "lockdown", which withholds everything either one does, is safe.
 */
export const PROTECTED_TIGHTENING: Readonly<Record<string, Tightening>> = {
  enableShell: { safe: false },
  enableHttp: { safe: false },
  enableBrowser: { safe: false },
  enableComputerControl: { safe: false },
  enableRemoteControl: { safe: false },
  enableUiEventBus: { safe: false },
  skillReviewEnabled: { safe: false },
  developer_mode: { safe: false },
  localOnlyMode: { safe: true },
  supervisedBrowser: { safe: true },
  learningMode: { safe: "assisted" },
  browserSecrecy: { safe: "lockdown" },
  toolApproval: { stricterLast: ["auto", "confirm-risky", "confirm-all"] },
};

/**
 * Protected settings where no change is narrower than another, so every change
 * is put to the user. browserMode trades one browser identity for another (a
 * fresh one per session, a persistent agent profile, one context shared by
 * every session); none is a subset of the others.
 */
export const PROTECTED_WITHOUT_SAFE_DIRECTION: ReadonlySet<string> = new Set(["browserMode"]);

/** True for a setting the agent may narrow but only the user may widen. */
export function isUserOwnedSetting(field: string): boolean {
  return isProtectedSetting(field) || SPENDING_CAP_SETTINGS.has(field);
}

/** The value the app runs with now: config.json for a runtime field, settings.json otherwise. */
export function currentSettingValue(field: string): unknown {
  const runtime = FLIPPABLE_SETTINGS.find((s) => s.field === field)?.runtime === true;
  return runtime ? (getRuntimeConfig() as unknown as Record<string, unknown>)[field] : loadSettings()[field];
}

const capOf = (usd: unknown): number => (typeof usd === "number" && usd > 0 ? usd : Infinity);

function lowersCap(value: unknown, current: unknown): boolean {
  return typeof value === "number" && value >= 0 && capOf(value) <= capOf(current);
}

/** Every model that is capped now stays capped at or under its cap. */
function lowersModelCaps(value: unknown, current: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const next = value as Record<string, unknown>;
  if (!Object.values(next).every((usd) => typeof usd === "number" && usd >= 0)) return false;
  const now = current && typeof current === "object" ? current as Record<string, unknown> : {};
  return Object.entries(now).every(([model, cap]) => capOf(next[model]) <= capOf(cap));
}

/**
 * Whether setting `field` to `value` can only narrow what the agent may do or
 * spend. `current` is read only for the settings whose answer depends on it.
 */
export function strictlyTightens(field: string, value: unknown, current: () => unknown = () => currentSettingValue(field)): boolean {
  if (field === "modelDailyBudgetsUsd") return lowersModelCaps(value, current());
  if (SPENDING_CAP_SETTINGS.has(field)) return lowersCap(value, current());
  const rule = PROTECTED_TIGHTENING[field];
  if (!rule) return false;
  if ("safe" in rule) return value === rule.safe;
  const to = rule.stricterLast.indexOf(value as string);
  if (to < 0) return false;
  const from = rule.stricterLast.indexOf(current() as string);
  return from >= 0 && to >= from;
}
