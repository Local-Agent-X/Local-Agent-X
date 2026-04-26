/**
 * Protocol System for Open Agent X
 *
 * Protocols are built-in multi-step workflows the agent can execute.
 * Unlike one-shot tools, protocols maintain state across steps and
 * encode hard-won knowledge (e.g., Instagram's caption formatting quirks).
 *
 * Built-in protocols ship with the app. User preferences (account names,
 * default hashtags, posting style) are stored per-user in ~/.sax/protocol-prefs/.
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import type { ToolDefinition } from "./types.js";

// ── Types ──

export interface ProtocolCondition {
  /** Variable or output key to evaluate */
  field: string;
  /** Comparison operator */
  operator: "equals" | "not_equals" | "contains" | "not_contains" | "exists" | "not_exists" | "gt" | "lt";
  /** Value to compare against (not needed for exists/not_exists) */
  value?: unknown;
}

export interface ProtocolStep {
  id: string;
  instruction: string;
  /** Tool calls the agent should make for this step */
  suggestedTools?: Array<{ tool: string; args: Record<string, unknown> }>;
  /** If true, wait for user confirmation before proceeding */
  requiresUserAction?: boolean;
  /** Validation to run after step completes */
  validate?: string;
  /** Condition that must be true to execute this step (if branch) */
  condition?: ProtocolCondition;
  /** Step ID to jump to if condition is false (else branch) */
  elseStep?: string;
  /** Step ID to jump to after this step completes (instead of next sequential step) */
  nextStep?: string;
}

/** Where a protocol came from. Drives UI affordances (read-only built-ins,
 *  attribution links for imports) and dedupe logic when multiple sources
 *  define the same name. */
export interface ProtocolSource {
  /**
   * "builtin": ships in src/protocols/packs/*.ts (typed, code-defined)
   * "bundled": shipped via protocols/bundled/ (vendored SKILL.md from upstream)
   * "imported": user-imported SKILL.md in ~/.lax/protocols/imported/<name>/
   * "custom": user-authored typed protocol in ~/.lax/custom-protocols.json
   */
  type: "builtin" | "bundled" | "imported" | "custom";
  /** Upstream repo URL/slug for bundled or imported protocols */
  repo?: string;
  /** Source commit SHA at import time */
  commit?: string;
  /** Source license (must be MIT / Apache-2.0 / CC-BY-4.0 to be imported) */
  license?: string;
  /** Attribution string preserved per source license */
  attribution?: string;
  /** Path on disk to the source file (for hot-reload + edit-in-place) */
  sourcePath?: string;
}

export interface Protocol {
  name: string;
  description: string;
  /** When the agent should suggest this protocol */
  triggers: string[];
  steps: ProtocolStep[];
  /** Hard-won lessons encoded as rules */
  rules: string[];
  /** What user preferences this protocol can learn */
  learnablePreferences: string[];
  /** Markdown body for prompt-style protocols (imported SKILL.md). When
   *  present, protocol_get returns this as the executable instruction text;
   *  steps[] is empty. Built-in typed packs use steps[] and leave body unset. */
  body?: string;
  /** Tools the agent is allowed to call while executing this protocol.
   *  Enforced via session policy on protocol_get, mirroring the prior
   *  skill_run gating. Empty/undefined = no restriction. */
  allowedTools?: string[];
  /** Provenance + identity of where this protocol came from. Required for
   *  bundled/imported/custom; optional only for legacy in-memory builtins. */
  source?: ProtocolSource;
  /** UI grouping. Falls back to keyword-derived category if absent. */
  category?: string;
  /** Free-form tags for search + filter. */
  tags?: string[];
}

export interface ProtocolPreferences {
  [missionName: string]: Record<string, unknown>;
}

// ── User Preferences (per-user, persisted) ──

const prefsDir = join(homedir(), ".lax", "protocol-prefs");

function loadPrefs(): ProtocolPreferences {
  const path = join(prefsDir, "prefs.json");
  if (existsSync(path)) {
    try { return JSON.parse(readFileSync(path, "utf-8")); } catch {}
  }
  return {};
}

function savePrefs(prefs: ProtocolPreferences): void {
  if (!existsSync(prefsDir)) mkdirSync(prefsDir, { recursive: true });
  writeFileSync(join(prefsDir, "prefs.json"), JSON.stringify(prefs, null, 2), "utf-8");
}

// ── Built-in Protocols ──

const instagramPost: Protocol = {
  name: "instagram_post",
  description: "Post photos/videos to Instagram with a formatted caption. Handles carousel ordering, cropping guidance, caption formatting (line breaks that actually work), and publishing.",
  triggers: [
    "post on instagram", "post to instagram", "instagram post",
    "make an instagram post", "publish on instagram", "share on instagram",
    "post this on ig", "put this on instagram",
  ],
  learnablePreferences: [
    "instagram_username",
    "default_hashtags",
    "caption_style",         // e.g. "emoji-heavy", "clean", "professional"
    "preferred_crop",        // e.g. "4:5", "1:1", "original"
    "signature_line",        // e.g. "📍 NutriShop McKinney"
    "always_include_cta",    // e.g. true (always end with call-to-action)
  ],
  rules: [
    // Caption formatting — the #1 pain point
    "CRITICAL: Instagram's web composer DESTROYS line breaks if you paste normally. To preserve formatting: use the browser 'evaluate' action to set the caption via JavaScript, NOT the 'fill' action. Use: document.querySelector('textarea, [contenteditable], [role=\"textbox\"]') and set value/textContent with literal \\n characters.",
    "NEVER paste the caption twice. After inserting, use 'snapshot' to verify the caption appears exactly once and is properly formatted.",
    "Keep the final caption in a variable throughout the conversation. If the user asks to use 'the caption from earlier', refer to it — never say you can't see it.",

    // Browser session management
    "Before navigating to Instagram, check if there's already an open Instagram tab using the 'tabs' action. If so, switch to it instead of opening a new one. This preserves the user's login session.",
    "If Instagram shows a login screen, tell the user to log in manually in the browser window. Do NOT attempt to fill credentials.",
    "After login confirmation, take a snapshot to verify you're on the right page before proceeding.",

    // Image/media handling
    "The OS file picker CANNOT be automated. Tell the user to select files manually. Be specific: tell them exactly which files and in what order.",
    "For carousel posts: tell the user the desired image order BEFORE they open the file picker. Once uploaded, reordering is unreliable via automation.",
    "For cropping: guide the user verbally (e.g., 'zoom in slightly on photo 2 so the full body is visible'). Only attempt automated crop if Instagram's UI supports it via accessible controls.",

    // Pre-publish verification
    "Before hitting Share/Publish: take a snapshot and verify: (1) caption is present and not duplicated, (2) correct number of images are shown, (3) no error banners visible.",
    "If anything looks wrong in the pre-publish check, STOP and tell the user what's wrong. Never publish a broken post.",

    // Post-publish
    "After publishing, confirm success by checking for the 'Post shared' confirmation or by navigating to the user's profile.",
  ],
  steps: [
    {
      id: "gather",
      instruction: "Collect from the user: (1) images/videos to post, (2) caption text or topic to write about, (3) post type (Feed/Story/Reel/Carousel). If they provide images, note the file paths. If they want you to write the caption, draft it and get approval before proceeding.",
    },
    {
      id: "draft_caption",
      instruction: "Write the caption. Apply user's preferred style if known. Include hashtags (use user's defaults + topic-specific ones). Format with clear line breaks between sections. Store the FINAL approved caption — you'll need it later.",
    },
    {
      id: "open_instagram",
      instruction: "Check for existing Instagram tabs first (browser 'tabs' action). If found, switch to it. Otherwise navigate to https://www.instagram.com/. Verify you're logged in via snapshot. If not logged in, ask user to log in manually.",
    },
    {
      id: "start_post",
      instruction: "Click the Create/New Post button (usually '+' icon or 'Create' in sidebar). Wait for the upload modal to appear.",
      requiresUserAction: false,
    },
    {
      id: "upload_media",
      instruction: "Tell the user to select their files in the OS file picker. Be specific about the order: 'Select [file1] first (this will be the cover), then [file2], then [file3].' Wait for user to confirm upload is done.",
      requiresUserAction: true,
    },
    {
      id: "review_media",
      instruction: "Take a snapshot. Check: (1) correct number of images, (2) image order matches what was requested, (3) cropping looks good. If anything needs adjustment, guide the user through fixing it. Only proceed when media looks right.",
      validate: "Snapshot shows correct number of media items in correct order",
    },
    {
      id: "advance_to_caption",
      instruction: "Click 'Next' to advance past filters/editing to the caption screen. Take a snapshot to confirm you're on the caption/share screen.",
    },
    {
      id: "insert_caption",
      instruction: "Insert the approved caption using JavaScript evaluation (NOT fill). Use: browser evaluate action with code that finds the textarea/contenteditable and sets the text with proper line breaks. Then take a snapshot to verify: caption appears exactly once, formatting is preserved, no duplication.",
      validate: "Caption appears exactly once in snapshot, with line breaks intact",
    },
    {
      id: "pre_publish_check",
      instruction: "Final verification snapshot. Check: (1) caption is correct and not duplicated, (2) media preview looks right, (3) no error messages. Report status to user and ask for 'go ahead' to publish.",
      requiresUserAction: true,
    },
    {
      id: "publish",
      instruction: "Click Share/Publish. Wait for confirmation. Take a snapshot to verify the post was published successfully.",
    },
    {
      id: "confirm",
      instruction: "Confirm to the user that the post is live. If possible, provide the post URL. Ask if they want to make any edits or post another.",
    },
  ],
};

// ── Conditional Step Evaluation ──

export function evaluateCondition(condition: ProtocolCondition, context: Record<string, unknown>): boolean {
  const fieldValue = context[condition.field];
  switch (condition.operator) {
    case "exists": return fieldValue !== undefined && fieldValue !== null;
    case "not_exists": return fieldValue === undefined || fieldValue === null;
    case "equals": return fieldValue === condition.value;
    case "not_equals": return fieldValue !== condition.value;
    case "contains": return typeof fieldValue === "string" && typeof condition.value === "string" && fieldValue.includes(condition.value);
    case "not_contains": return typeof fieldValue === "string" && typeof condition.value === "string" && !fieldValue.includes(condition.value);
    case "gt": return typeof fieldValue === "number" && typeof condition.value === "number" && fieldValue > condition.value;
    case "lt": return typeof fieldValue === "number" && typeof condition.value === "number" && fieldValue < condition.value;
    default: return true;
  }
}

export function resolveNextStep(step: ProtocolStep, steps: ProtocolStep[], context: Record<string, unknown>): ProtocolStep | null {
  if (step.condition) {
    const result = evaluateCondition(step.condition, context);
    if (!result && step.elseStep) {
      return steps.find(s => s.id === step.elseStep) ?? null;
    }
    if (!result) {
      const idx = steps.indexOf(step);
      return idx + 1 < steps.length ? steps[idx + 1] : null;
    }
  }
  if (step.nextStep) {
    return steps.find(s => s.id === step.nextStep) ?? null;
  }
  const idx = steps.indexOf(step);
  return idx + 1 < steps.length ? steps[idx + 1] : null;
}

// ── Dry-Run Execution ──

export interface DryRunResult {
  missionName: string;
  steps: Array<{
    id: string;
    instruction: string;
    wouldExecuteTools: Array<{ tool: string; args: Record<string, unknown> }>;
    requiresUserAction: boolean;
    hasCondition: boolean;
    conditionSummary?: string;
  }>;
  totalSteps: number;
  userActionSteps: number;
  conditionalSteps: number;
}

export function dryRunProtocol(protocol: Protocol, context: Record<string, unknown> = {}): DryRunResult {
  const drySteps = protocol.steps.map(step => {
    const conditionMet = step.condition ? evaluateCondition(step.condition, context) : true;
    return {
      id: step.id,
      instruction: conditionMet ? step.instruction : `[SKIPPED — condition not met: ${step.condition?.field} ${step.condition?.operator} ${step.condition?.value ?? ""}]`,
      wouldExecuteTools: conditionMet ? (step.suggestedTools ?? []) : [],
      requiresUserAction: conditionMet ? (step.requiresUserAction ?? false) : false,
      hasCondition: !!step.condition,
      conditionSummary: step.condition ? `${step.condition.field} ${step.condition.operator} ${step.condition.value ?? ""}` : undefined,
    };
  });

  return {
    missionName: protocol.name,
    steps: drySteps,
    totalSteps: drySteps.length,
    userActionSteps: drySteps.filter(s => s.requiresUserAction).length,
    conditionalSteps: drySteps.filter(s => s.hasCondition).length,
  };
}

// ── Registry ──

import { loadCustomProtocols } from "./protocols/builder.js";
import { socialProtocols } from "./protocols/packs/social.js";
import { developerProtocols } from "./protocols/packs/developer.js";
// Smart home pack removed — no smart home APIs available in the platform
import { researchProtocols } from "./protocols/packs/research.js";
import { communicationProtocols } from "./protocols/packs/communication.js";
import { createAllProtocolTools } from "./protocols/index.js";
import {
  loadBundledProtocols, loadImportedProtocols,
  stampBuiltinSource, stampCustomSource, mergeByName,
} from "./protocols/loader.js";

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
    q.includes(pb.name.toLowerCase()) || pb.name.toLowerCase().includes(q)
  );
}

// ── Caption Formatting Helper ──
// This encodes the hard-won knowledge about Instagram's composer

function formatCaptionForInstagram(caption: string): string {
  // Instagram web composer needs actual newlines, not markdown breaks
  // Replace any \r\n or \r with \n for consistency
  let clean = caption.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  // Collapse 3+ newlines to 2 (Instagram ignores excessive spacing)
  clean = clean.replace(/\n{3,}/g, "\n\n");
  return clean;
}

// JavaScript code to inject caption into Instagram's composer
function buildCaptionInjector(caption: string): string {
  // Escape for JS string literal using JSON.stringify (handles all special chars)
  const escaped = JSON.stringify(caption).slice(1, -1); // strip outer quotes

  return `
    (function() {
      // Try multiple selectors — Instagram changes these
      const selectors = [
        'textarea',
        '[contenteditable="true"]',
        '[role="textbox"]',
        '[aria-label="Write a caption..."]',
        '[aria-label*="caption"]',
        'div[data-lexical-editor="true"]',
      ];
      for (const sel of selectors) {
        const el = document.querySelector(sel);
        if (!el) continue;

        // Focus the element first
        el.focus();
        el.click();

        if (el.tagName === 'TEXTAREA') {
          // Native textarea — set value + dispatch events
          const nativeSetter = Object.getOwnPropertyDescriptor(
            window.HTMLTextAreaElement.prototype, 'value'
          ).set;
          nativeSetter.call(el, '${escaped}');
          el.dispatchEvent(new Event('input', { bubbles: true }));
          el.dispatchEvent(new Event('change', { bubbles: true }));
          return 'Caption inserted via textarea';
        } else {
          // ContentEditable / Lexical editor
          // Clear existing content
          el.innerHTML = '';
          // Insert with line breaks as <br> or paragraphs
          const lines = '${escaped}'.split('\\n');
          // Use execCommand for undo support
          document.execCommand('selectAll', false, null);
          document.execCommand('delete', false, null);

          // Type each line with proper breaks
          for (let i = 0; i < lines.length; i++) {
            if (i > 0) {
              // Insert line break
              document.execCommand('insertParagraph', false, null);
            }
            if (lines[i]) {
              document.execCommand('insertText', false, lines[i]);
            }
          }
          return 'Caption inserted via contenteditable';
        }
      }
      return 'ERROR: Could not find caption input element';
    })()
  `.trim();
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
          `• **${pb.name}**: ${pb.description}\n  Triggers: ${pb.triggers.slice(0, 3).map(t => `"${t}"`).join(", ")}...`
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
          `  Step ${i + 1} [${s.id}]: ${s.instruction}${s.requiresUserAction ? " ⏸️ (needs user action)" : ""}${s.validate ? `\n    ✓ Validate: ${s.validate}` : ""}`
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
          `  ${i + 1}. [${s.id}] ${s.instruction}${s.requiresUserAction ? " ⏸️" : ""}${s.hasCondition ? ` 🔀 (${s.conditionSummary})` : ""}${s.wouldExecuteTools.length ? `\n     Tools: ${s.wouldExecuteTools.map(t => t.tool).join(", ")}` : ""}`
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
