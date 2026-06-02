/**
 * `setting` — the canonical way for the agent to flip app settings.
 *
 * Wraps the FLIPPABLE_SETTINGS schema so the agent has ONE small eager tool
 * to control its own behavior (theme, provider, model, toolApproval, Tool
 * Policy kill-switches, maxIterations, etc.) instead of reaching for the
 * larger http_request tool and a guessed URL/field name.
 *
 * Why a dedicated tool instead of just http_request:
 *   - Eager-tool token budget — http_request is ~400 tokens of schema; a
 *     focused `setting` tool is ~150 tokens and never tempts the model to
 *     hit external URLs for self-control.
 *   - The parameter schema IS the documentation — the agent literally
 *     can't pass an unknown field because the schema lists them.
 *   - Wrong-field guesses (the `shellAccess` failure 2026-05-19) return a
 *     clean error with the valid field list, not a silent 200 merge.
 *
 * Runtime fields (toolApproval, enable*, etc.) get mirrored to config.json
 * + ctx.config so the next tool call sees the new value. Broadcasts the
 * change over WS so other tabs (and the settings page) re-sync the toggle
 * DOM without a refresh.
 */
import { z } from "zod";
import { FLIPPABLE_SETTINGS, RUNTIME_SETTINGS, BROADCAST_KEYS } from "../settings-schema.js";
import { getRuntimeConfig, saveConfig, getConfigPath } from "../config.js";
import { loadSettings, saveSettings } from "../settings.js";
import type { ToolDefinition } from "../types.js";
import { ok, err } from "./result-helpers.js";
import { verifyWriteLanded } from "./verify.js";

function listKnownFields(): string {
  return FLIPPABLE_SETTINGS.map((s) => {
    const def = (s.validate as unknown as { _def?: { typeName?: string; values?: unknown[] } })._def;
    if (def?.typeName === "ZodEnum" && Array.isArray(def.values)) {
      return `  - ${s.field} (${def.values.join("|")}): ${s.description}`;
    }
    if (def?.typeName === "ZodBoolean") return `  - ${s.field} (boolean): ${s.description}`;
    if (def?.typeName === "ZodNumber") return `  - ${s.field} (number): ${s.description}`;
    return `  - ${s.field}: ${s.description}`;
  }).join("\n");
}

export const settingTool: ToolDefinition = {
  name: "setting",
  description:
    "Flip an app setting (theme, provider, model, toolApproval, Tool Policy kill-switches, etc.). " +
    "Use this INSTEAD of http_request for any change the user requests to the app itself. " +
    "The field list is the canonical set — pass any other field name and you get back the valid list. " +
    "Runtime-bound fields (maxIterations, temperature, bridgeVoicePreference) " +
    "take effect on the very next tool call — no restart. " +
    "Security fields (toolApproval, enableShell/Http/Browser) are user-owned: when the USER asks you to change one, DO call this tool with that field and it takes effect immediately. " +
    "The only rule: change a security setting ONLY when the user explicitly asked for it — never flip one on your own initiative, and never silently re-enable a capability just to get past a block.",
  parameters: {
    type: "object",
    properties: {
      field: {
        type: "string",
        description: "Setting field name. Run with `field: \"?\"` or any unknown name to list valid fields with their accepted values.",
      },
      value: {
        description: "New value. Type depends on the field (boolean / enum string / number). See the field list for accepted values.",
      },
    },
    required: ["field", "value"],
  },
  async execute(args) {
    const fieldName = String(args.field || "");
    if (!fieldName || fieldName === "?" || fieldName === "list") {
      return ok(`Valid setting fields:\n${listKnownFields()}\n\nCall again with field + value to apply a change.`);
    }

    const spec = FLIPPABLE_SETTINGS.find((s) => s.field === fieldName);
    if (!spec) {
      return err(
        `Unknown setting field "${fieldName}". Valid fields:\n${listKnownFields()}`,
        { recovery: "Pick a field name from the list above and retry." },
      );
    }

    const parsed = spec.validate.safeParse(args.value);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      return err(
        `Invalid value for "${fieldName}": ${issue?.message || "validation failed"}.\n\nField spec:\n${listKnownFields().split("\n").filter((l) => l.includes(fieldName)).join("\n")}`,
        { recovery: "Re-call with a value that matches the field's accepted type/enum." },
      );
    }
    const newValue = parsed.data;

    // 1) Persist to settings.json (UI cache + UI-only fields read here).
    const merged = { ...loadSettings(), [fieldName]: newValue };
    saveSettings(merged);

    // 2) If runtime-bound, mirror to config.json + in-memory ctx.config
    //    so the gate / dispatcher reads the new value on the next call.
    if (spec.runtime) {
      const cfg = getRuntimeConfig();
      (cfg as unknown as Record<string, unknown>)[fieldName] = newValue;
      saveConfig(cfg);

      // Sanity check: confirm the mutation landed on disk. If saveConfig
      // silently truncated, wrote to the wrong path, or the rename failed,
      // we'd otherwise return ok and the user would think a security
      // toggle took effect when it didn't. mustContain is keyed on the
      // serialized key/value pair the JSON.stringify(cfg, null, 2) emits —
      // matches both boolean and string/number values.
      const expected = `"${fieldName}": ${JSON.stringify(newValue)}`;
      const verified = verifyWriteLanded(getConfigPath(), { mustContain: expected });
      if (!verified.ok) {
        return err(
          `Saved ${fieldName} = ${JSON.stringify(newValue)} but post-write verify failed: ${verified.reason}. The toggle did NOT take effect.`,
          { recovery: "Re-call setting with the same field/value; if it keeps failing, check ~/.lax/config.json permissions and disk space." },
        );
      }
    }

    // 3) Broadcast to all connected browsers so toggles/UI dropdowns re-sync.
    // Capture the client count so we can tell the user when nothing
    // received the update (UI-affecting setting + no open tabs → they
    // need to refresh manually for the setting page to reflect it).
    let broadcastClients = 0;
    let broadcastAttempted = false;
    if (BROADCAST_KEYS.has(fieldName)) {
      broadcastAttempted = true;
      try {
        const { broadcastAll } = await import("../chat-ws/index.js");
        broadcastClients = broadcastAll({ type: "settings_changed", settings: { [fieldName]: newValue } });
      } catch {}
    }

    const verifyHint = (fieldName === "enableShell" && newValue === false)
      ? " Verify with `bash echo ok` — it should return BLOCKED by tool-policy."
      : (fieldName === "enableHttp" && newValue === false)
        ? " Verify with `http_request {url: http://127.0.0.1}` — it should return BLOCKED by tool-policy."
        : (fieldName === "enableBrowser" && newValue === false)
          ? " Verify with any `browser_*` call — it should return BLOCKED by tool-policy."
          : "";

    const metadata: Record<string, unknown> = {
      field: fieldName,
      value: newValue,
      runtime: spec.runtime,
    };
    if (broadcastAttempted) {
      metadata.broadcast_clients = broadcastClients;
      if (broadcastClients === 0) {
        metadata.userHint = `Setting saved (no active UI clients to notify; refresh the app to see the new ${fieldName} value).`;
      }
    }
    return ok(`Set ${fieldName} = ${JSON.stringify(newValue)}.${verifyHint}`, metadata);
  },
  audiences: ["main-chat", "spawned-agent"],
};
