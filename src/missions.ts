/**
 * Mission System for Open Agent X
 *
 * Missions are built-in multi-step procedures the agent can execute.
 * Unlike one-shot tools, missions maintain state across steps and
 * encode hard-won knowledge (e.g., Instagram's caption formatting quirks).
 *
 * Built-in missions ship with the app. User preferences (account names,
 * default hashtags, posting style) are stored per-user in ~/.sax/mission-prefs/.
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import type { ToolDefinition } from "./types.js";

// ── Types ──

export interface MissionStep {
  id: string;
  instruction: string;
  /** Tool calls the agent should make for this step */
  suggestedTools?: Array<{ tool: string; args: Record<string, unknown> }>;
  /** If true, wait for user confirmation before proceeding */
  requiresUserAction?: boolean;
  /** Validation to run after step completes */
  validate?: string;
}

export interface Mission {
  name: string;
  description: string;
  /** When the agent should suggest this mission */
  triggers: string[];
  steps: MissionStep[];
  /** Hard-won lessons encoded as rules */
  rules: string[];
  /** What user preferences this mission can learn */
  learnablePreferences: string[];
}

export interface MissionPreferences {
  [missionName: string]: Record<string, unknown>;
}

// ── User Preferences (per-user, persisted) ──

const prefsDir = join(homedir(), ".sax", "mission-prefs");

function loadPrefs(): MissionPreferences {
  const path = join(prefsDir, "prefs.json");
  if (existsSync(path)) {
    try { return JSON.parse(readFileSync(path, "utf-8")); } catch {}
  }
  return {};
}

function savePrefs(prefs: MissionPreferences): void {
  if (!existsSync(prefsDir)) mkdirSync(prefsDir, { recursive: true });
  writeFileSync(join(prefsDir, "prefs.json"), JSON.stringify(prefs, null, 2), "utf-8");
}

// ── Built-in Missions ──

const instagramPost: Mission = {
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

// ── Registry ──

const BUILT_IN_PLAYBOOKS: Mission[] = [
  instagramPost,
];

function findMission(query: string): Mission | undefined {
  const q = query.toLowerCase();
  return BUILT_IN_PLAYBOOKS.find(pb =>
    pb.triggers.some(t => q.includes(t)) || q.includes(pb.name)
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
  // Escape for JS string literal
  const escaped = caption
    .replace(/\\/g, "\\\\")
    .replace(/'/g, "\\'")
    .replace(/\n/g, "\\n");

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

export function createMissionTools(): ToolDefinition[] {
  return [
    {
      name: "mission_list",
      description: "List all available missions. Use this when the user asks what you can do autonomously or wants to see available workflows.",
      parameters: { type: "object", properties: {} },
      async execute() {
        const list = BUILT_IN_PLAYBOOKS.map(pb =>
          `• **${pb.name}**: ${pb.description}\n  Triggers: ${pb.triggers.slice(0, 3).map(t => `"${t}"`).join(", ")}...`
        ).join("\n\n");
        return { content: `Available missions:\n\n${list}` };
      },
    },

    {
      name: "mission_get",
      description: "Get a mission's full steps, rules, and user preferences. Call this BEFORE executing a multi-step workflow like posting to Instagram. The rules contain critical lessons (e.g., how to format captions that don't break).",
      parameters: {
        type: "object",
        properties: {
          name: { type: "string", description: "Mission name or trigger phrase (e.g., 'instagram_post' or 'post on instagram')" },
        },
        required: ["name"],
      },
      async execute(args) {
        const pb = findMission(String(args.name || ""));
        if (!pb) {
          return { content: `No mission found for "${args.name}". Use mission_list to see available missions.` };
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
          content: `# Mission: ${pb.name}\n${pb.description}\n\n## RULES (follow these strictly):\n${rulesText}\n\n## STEPS:\n${stepsText}${prefsText}`,
        };
      },
    },

    {
      name: "mission_save_preference",
      description: "Save a user preference for a mission. This lets the mission personalize to each user over time (e.g., their Instagram username, default hashtags, preferred caption style).",
      parameters: {
        type: "object",
        properties: {
          mission: { type: "string", description: "Mission name" },
          key: { type: "string", description: "Preference key (e.g., 'instagram_username', 'default_hashtags')" },
          value: { type: "string", description: "Preference value" },
        },
        required: ["mission", "key", "value"],
      },
      async execute(args) {
        const pbName = String(args.mission || "");
        const key = String(args.key || "");
        const value = String(args.value || "");

        const pb = findMission(pbName);
        if (!pb) return { content: `Unknown mission: "${pbName}"` };
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
      name: "mission_format_caption",
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
  ];
}
