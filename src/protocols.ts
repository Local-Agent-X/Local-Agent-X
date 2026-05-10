/**
 * Protocol System for Local Agent X
 *
 * Protocols are built-in multi-step workflows the agent can execute.
 * Unlike one-shot tools, protocols maintain state across steps and
 * encode hard-won knowledge (e.g., Instagram's caption formatting quirks).
 *
 * Built-in protocols ship with the app. User preferences (account names,
 * default hashtags, posting style) are stored per-user in ~/.lax/protocol-prefs/.
 *
 * Layout:
 *   - protocols/types.ts        — Protocol / ProtocolStep / ProtocolSource shapes
 *   - protocols/preferences.ts  — load/save per-user prefs
 *   - protocols/evaluation.ts   — evaluateCondition / resolveNextStep / dryRunProtocol
 *   - protocols/packs/*.ts      — built-in typed protocols by domain
 *   - protocols/loader.ts       — bundled SKILL.md + custom typed merging
 *   - protocols/index.ts        — submodule tools (builder, marketplace, etc.)
 */

import type { ToolDefinition } from "./types.js";

import { dryRunProtocol } from "./protocols/evaluation.js";
import { loadCustomProtocols } from "./protocols/builder.js";
import { socialProtocols } from "./protocols/packs/social.js";
import { developerProtocols } from "./protocols/packs/developer.js";
import { researchProtocols } from "./protocols/packs/research.js";
import { communicationProtocols } from "./protocols/packs/communication.js";
import { buildCaptionInjector, formatCaptionForInstagram, instagramPost } from "./protocols/packs/instagram.js";
import { createAllProtocolTools } from "./protocols/index.js";
import {
  loadBundledProtocols, loadImportedProtocols,
  stampBuiltinSource, stampCustomSource, mergeByName,
} from "./protocols/loader.js";
import { loadPrefs, savePrefs } from "./protocols/preferences.js";
import type { Protocol } from "./protocols/types.js";

export type {
  Protocol,
  ProtocolCondition,
  ProtocolSource,
  ProtocolStep,
} from "./protocols/types.js";
export type { ProtocolPreferences } from "./protocols/preferences.js";
export {
  dryRunProtocol,
  evaluateCondition,
  resolveNextStep,
  type DryRunResult,
} from "./protocols/evaluation.js";

/**
 * Three-tier merge: built-in typed packs → bundled SKILL.md (vendored) →
 * user-imported SKILL.md and user custom typed records. Later sources
 * override earlier ones on name collision so users can shadow anything
 * shipped with the app by writing into ~/.lax/protocols/imported/<name>/
 * or ~/.lax/custom-protocols.json.
 */
export function getAllProtocols(): Protocol[] {
  const builtins = stampBuiltinSource([
    instagramPost,
    ...socialProtocols,
    ...developerProtocols,
    ...researchProtocols,
    ...communicationProtocols,
  ]);
  const bundled = loadBundledProtocols();
  const imported = loadImportedProtocols();
  const custom = stampCustomSource(loadCustomProtocols());
  return mergeByName(builtins, bundled, imported, custom);
}

function findProtocol(query: string): Protocol | undefined {
  const q = query.toLowerCase();
  return getAllProtocols().find(pb =>
    pb.triggers.some(t => q.includes(t.toLowerCase()) || t.toLowerCase().includes(q)) ||
    q.includes(pb.name.toLowerCase()) || pb.name.toLowerCase().includes(q),
  );
}

// ── Tool Exports ──

export function createCoreProtocolTools(): ToolDefinition[] {
  return [
    {
      name: "protocol_list",
      description: "List all available protocols (pre-built workflows the agent knows). Use when the user asks what you can do, your capabilities, or available protocols.",
      parameters: { type: "object", properties: {} },
      async execute() {
        const all = getAllProtocols();
        const list = all.map(pb =>
          `• **${pb.name}**: ${pb.description}\n  Triggers: ${pb.triggers.slice(0, 3).map(t => `"${t}"`).join(", ")}...`,
        ).join("\n\n");
        return { content: `Available protocols (${all.length}):\n\n${list}` };
      },
    },

    {
      name: "protocol_get",
      description: "Get a protocol's full steps, rules, and user preferences. Call this BEFORE executing a multi-step workflow like posting to Instagram. The rules contain critical lessons (e.g., how to format captions that don't break).",
      parameters: {
        type: "object",
        properties: {
          name: { type: "string", description: "Protocol name or trigger phrase (e.g., 'instagram_post' or 'post on instagram')" },
        },
        required: ["name"],
      },
      async execute(args) {
        const pb = findProtocol(String(args.name || ""));
        if (!pb) {
          return { content: `No protocol found for "${args.name}". Use protocol_list to see all available protocols.` };
        }

        const prefs = loadPrefs()[pb.name] || {};
        const prefsText = Object.keys(prefs).length > 0
          ? "\n\nUser Preferences:\n" + Object.entries(prefs).map(([k, v]) => `  ${k}: ${v}`).join("\n")
          : "\n\nNo user preferences saved yet.";

        const rulesText = pb.rules.map((r, i) => `  ${i + 1}. ${r}`).join("\n");
        const stepsText = pb.steps.map((s, i) =>
          `  Step ${i + 1} [${s.id}]: ${s.instruction}${s.requiresUserAction ? " ⏸️ (needs user action)" : ""}${s.validate ? `\n    ✓ Validate: ${s.validate}` : ""}`,
        ).join("\n\n");

        return {
          content: `# Protocol: ${pb.name}\n${pb.description}\n\n## RULES (follow these strictly):\n${rulesText}\n\n## STEPS:\n${stepsText}${prefsText}`,
        };
      },
    },

    {
      name: "protocol_save_preference",
      description: "Save a user preference for a protocol. This lets the protocol personalize to each user over time (e.g., their Instagram username, default hashtags, preferred caption style).",
      parameters: {
        type: "object",
        properties: {
          protocol: { type: "string", description: "Protocol name" },
          key: { type: "string", description: "Preference key (e.g., 'instagram_username', 'default_hashtags')" },
          value: { type: "string", description: "Preference value" },
        },
        required: ["protocol", "key", "value"],
      },
      async execute(args) {
        const pbName = String(args.protocol || "");
        const key = String(args.key || "");
        const value = String(args.value || "");

        const pb = findProtocol(pbName);
        if (!pb) return { content: `Unknown protocol: "${pbName}"` };
        if (!pb.learnablePreferences.includes(key)) {
          return { content: `"${key}" is not a learnable preference for ${pb.name}. Valid: ${pb.learnablePreferences.join(", ")}` };
        }

        const prefs = loadPrefs();
        if (!prefs[pb.name]) prefs[pb.name] = {};
        prefs[pb.name][key] = value;
        savePrefs(prefs);

        return { content: `Saved preference for ${pb.name}: ${key} = "${value}"` };
      },
    },

    {
      name: "protocol_format_caption",
      description: "Format a caption for Instagram posting. Returns the properly formatted caption AND the JavaScript code to inject it into Instagram's composer without breaking line breaks or duplicating text. ALWAYS use this before inserting a caption.",
      parameters: {
        type: "object",
        properties: {
          caption: { type: "string", description: "The raw caption text with line breaks" },
        },
        required: ["caption"],
      },
      async execute(args) {
        const raw = String(args.caption || "");
        const formatted = formatCaptionForInstagram(raw);
        const jsCode = buildCaptionInjector(formatted);

        // Character count check
        const charCount = formatted.length;
        const hashtagCount = (formatted.match(/#\w+/g) || []).length;
        const warnings: string[] = [];
        if (charCount > 2200) warnings.push(`⚠️ Caption is ${charCount} chars (Instagram limit: 2,200)`);
        if (hashtagCount > 30) warnings.push(`⚠️ ${hashtagCount} hashtags (Instagram limit: 30)`);

        return {
          content: [
            "## Formatted Caption:",
            "```",
            formatted,
            "```",
            `Characters: ${charCount}/2200 | Hashtags: ${hashtagCount}/30`,
            warnings.length ? warnings.join("\n") : "✅ Within limits",
            "",
            "## To insert into Instagram, use browser 'evaluate' action with this code:",
            "```js",
            jsCode,
            "```",
            "",
            "⚠️ After inserting, ALWAYS take a snapshot to verify the caption appears exactly ONCE and is properly formatted.",
          ].join("\n"),
        };
      },
    },

    {
      name: "protocol_dry_run",
      description: "Preview a protocol's execution plan without actually running it. Shows which steps would execute, which require user action, and evaluates conditions against provided context.",
      parameters: {
        type: "object",
        properties: {
          name: { type: "string", description: "Protocol name or trigger phrase" },
          context: { type: "object", description: "Context variables to evaluate conditions against" },
        },
        required: ["name"],
      },
      async execute(args) {
        const pb = findProtocol(String(args.name || ""));
        if (!pb) return { content: `No protocol found for "${args.name}".` };

        const ctx = (args.context as Record<string, unknown>) ?? {};
        const result = dryRunProtocol(pb, ctx);

        const stepsText = result.steps.map((s, i) =>
          `  ${i + 1}. [${s.id}] ${s.instruction}${s.requiresUserAction ? " ⏸️" : ""}${s.hasCondition ? ` 🔀 (${s.conditionSummary})` : ""}${s.wouldExecuteTools.length ? `\n     Tools: ${s.wouldExecuteTools.map(t => t.tool).join(", ")}` : ""}`,
        ).join("\n");

        return {
          content: `# Dry Run: ${result.missionName}\n\nSteps: ${result.totalSteps} | User actions: ${result.userActionSteps} | Conditional: ${result.conditionalSteps}\n\n${stepsText}`,
        };
      },
    },

    // Include all submodule tools (builder, marketplace, templates, chain, progress, rollback, variables)
    ...createAllProtocolTools(),
  ];
}
