/**
 * Protocol System — central index for all protocol modules.
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
 */

import type { ToolDefinition } from "../types.js";

import { dryRunProtocol } from "./evaluation.js";
import { loadCustomProtocols, createBuilderTools } from "./builder.js";
import { socialProtocols } from "./packs/social.js";
import { developerProtocols } from "./packs/developer.js";
import { researchProtocols } from "./packs/research.js";
import { communicationProtocols } from "./packs/communication.js";
import { buildCaptionInjector, formatCaptionForInstagram, instagramPost } from "./packs/instagram.js";
import {
  loadBundledProtocols, loadImportedProtocols,
  stampBuiltinSource, stampCustomSource, mergeByName,
} from "./loader.js";
import { loadPrefs, savePrefs } from "./preferences.js";
import { createMarketplaceTools } from "./marketplace.js";
import { createTemplateTools } from "./templates.js";
import { createChainTools } from "./chain.js";
import { createProgressTools } from "./progress.js";
import { createRollbackTools } from "./rollback.js";
import { createVariableTools } from "./variables.js";
import { createProtocolSearchTool } from "./search.js";
import { createProtocolStatsTools } from "./stats-tools.js";
import { createCuratorTools } from "./curator.js";
import type { Protocol } from "./types.js";

// ── Re-exports ────────────────────────────────────────────────

// Core modules
export { loadCustomProtocols, saveCustomProtocols, createProtocol, editProtocol, deleteProtocol, getProtocol, createBuilderTools } from "./builder.js";
export {
  loadArchived, saveArchived, archiveProtocol, unarchiveProtocol, purgeArchivedProtocol,
  computeProtocolState, applyAutomaticTransitions,
  type ArchivedRecord, type ProtocolState, type TransitionReport,
} from "./archive.js";
export { runCurator, loadCuratorState, shouldCurate, createCuratorTools, type CuratorReport, type RunCuratorOpts } from "./curator.js";
export { fetchRegistry, searchProtocols, installProtocol, createMarketplaceTools } from "./marketplace.js";
export { TEMPLATES, getTemplate, protocolFromTemplate, createTemplateTools } from "./templates.js";
export { createChain, startChain, advanceChain, getChainState, resolveInputs, failChain, createChainTools } from "./chain.js";
export { startExecution, completeStep, failStep, skipStep, pauseExecution, resumeExecution, getProgress, getAllExecutions, createProgressTools } from "./progress.js";
export { createRollbackSession, saveSnapshot, rollbackToStep, rollbackLast, getSnapshots, getSession, createRollbackTools } from "./rollback.js";
export { loadVariables, saveVariables, getVariable, setVariable, deleteVariable, listVariables, interpolateVariables, createVariableTools } from "./variables.js";

// Protocol packs
export { socialProtocols } from "./packs/social.js";
export { developerProtocols } from "./packs/developer.js";
export { smarthomeProtocols } from "./packs/smarthome.js";
export { researchProtocols } from "./packs/research.js";
export { communicationProtocols } from "./packs/communication.js";

// Types
export type { ProtocolTemplate } from "./templates.js";
export type { ChainLink, ProtocolChain, ChainExecutionState } from "./chain.js";
export type { StepStatus, StepProgress, ProtocolProgress } from "./progress.js";
export type { StateSnapshot, RollbackSession } from "./rollback.js";
export type { VariableScope } from "./variables.js";

export type {
  Protocol,
  ProtocolCondition,
  ProtocolSource,
  ProtocolStep,
} from "./types.js";
export type { ProtocolPreferences } from "./preferences.js";
export {
  dryRunProtocol,
  evaluateCondition,
  resolveNextStep,
  type DryRunResult,
} from "./evaluation.js";

/** Returns all protocol-system tools from submodules. */
export function createAllProtocolTools(): ToolDefinition[] {
  return [
    ...createBuilderTools(),
    ...createMarketplaceTools(),
    ...createTemplateTools(),
    ...createChainTools(),
    ...createProgressTools(),
    ...createRollbackTools(),
    ...createVariableTools(),
    ...createProtocolStatsTools(),
    ...createCuratorTools(),
    createProtocolSearchTool(),
  ];
}

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
        // Record the invocation — strongest signal of actual use. Drives the
        // never-used / least-used reports that protocol_prune consumes.
        try {
          const { recordUsage } = await import("./usage.js");
          recordUsage({
            action: "invoked",
            name: pb.name,
            sessionId: typeof (args as { _sessionId?: string })._sessionId === "string" ? (args as { _sessionId: string })._sessionId : undefined,
          });
        } catch { /* telemetry never fails the call */ }

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
