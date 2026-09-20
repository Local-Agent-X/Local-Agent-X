import type { ToolDefinition } from "../types.js";
import { resolveToolsForRequest } from "../tools/tool-search.js";

// ── Smart Tool Filtering ──
// Always include core tools. Add extras if the user's message hints at them.
// tool_search is always included so the agent can discover anything else.

// Audience mapping (which tools are eager for which audience) is owned by
// src/tools/audience-map.ts. This file owns the keyword router and the
// literal-tool-call detector, which the main-chat resolver injects into
// resolveToolsForRequest. Keywords only ADD tools; nothing here removes one.

// Keywords that trigger including specific tool groups
const TOOL_KEYWORD_MAP: Array<{ keywords: RegExp; exclude?: RegExp; toolPrefixes: string[] }> = [
  { keywords: /spreadsheet|excel|xlsx|csv|sheet/i, toolPrefixes: ["spreadsheet"] },
  { keywords: /\bdocs?\b|document|docx|\bword\b/i, toolPrefixes: ["document"] },
  // "power point" (spaced), "ppt", and "slide deck"/"deck" are how users
  // actually type it — the unspaced-only match left the presentation tool out
  // of the schema for "make a power point ..." (2026-06-10 misroute).
  { keywords: /presentation|slide|pptx?\b|power\s*point|\bdeck\b|keynote/i, toolPrefixes: ["presentation"] },
  { keywords: /pdf/i, toolPrefixes: ["pdf"] },
  { keywords: /email|mail|inbox|send.*email/i, toolPrefixes: ["email_"] },
  { keywords: /calendar|event|meeting|schedule.*event/i, toolPrefixes: ["calendar_"] },
  { keywords: /clipboard|copy|paste/i, toolPrefixes: ["clipboard_"] },
  { keywords: /sql|database|query.*table|postgres|sqlite/i, toolPrefixes: ["sql_"] },
  // image_search rides this rule too: FINDING a photo is what "add photos"
  // usually means, and the prefix list only ever matched the GENERATE side, so
  // the one tool that fetches real images never surfaced. The presentation
  // tool's own failure text tells the model to "Run image_search for
  // replacement URLs" — a local 27B did exactly that and was told the tool did
  // not exist (2026-09-19).
  { keywords: /image|photo|generate.*image|draw|picture|\bedit\b/i, toolPrefixes: ["generate_image", "edit_image", "generate_video", "image_search", "ocr"] },
  {
    keywords: /screen\s*shot|\bdesktop\b|\bmonitor\b|whole screen|my screen/i,
    exclude: /\b(browser|web\s*page|tab|site|website)\b/i,
    toolPrefixes: ["screen_capture"],
  },
  { keywords: /camera|webcam/i, toolPrefixes: ["camera_"] },
  { keywords: /transcrib|what.*(said|says)|voice\s*note|recording|podcast|audio|\bmp3\b|\bwav\b|\bm4a\b/i, toolPrefixes: ["transcribe_media"] },
  { keywords: /\bvideo\b|\bwatch\b|\bmp4\b|\bclip\b|\bfootage\b/i, toolPrefixes: ["read_video_frames", "transcribe_media"] },
  // App tools surface on "app/dashboard/tracker" mentions. Sidebar tools are a
  // SEPARATE rule that requires an explicit sidebar/pin/unpin keyword — the
  // old combined rule was the root cause of Codex reflexively pinning apps
  // to the sidebar whenever the user said anything with "app" in it (e.g.
  // "use this image as the background for my to-do app" → model sees
  // sidebar_pin available + description says "use when user says add" →
  // misroutes to pin).
  { keywords: /\bapp\b|dashboard|tracker/i, toolPrefixes: ["app_"] },
  { keywords: /\bsidebar\b|\bpin\b|\bunpin\b/i, toolPrefixes: ["sidebar_"] },
  { keywords: /issue|ticket|kanban/i, toolPrefixes: ["issue_"] },
  // "project" is ambiguous — could mean an issue-tracker project (issue_*)
  // OR a Local-Agent-X project container (project_*). Surface both; the
  // model picks based on phrasing ("create a project" → project_create,
  // "open project ABC's issues" → issue_list).
  { keywords: /\bproject\b/i, toolPrefixes: ["project_", "issue_"] },
  { keywords: /instagram|twitter|tiktok|social|post on/i, toolPrefixes: ["mission_"] },
  { keywords: /config|setting/i, toolPrefixes: ["config_"] },
  { keywords: /skill/i, toolPrefixes: ["skill_"] },
  { keywords: /rollback|undo.*mission/i, toolPrefixes: ["mission_rollback_"] },
  { keywords: /chain|pipeline/i, toolPrefixes: ["mission_chain_"] },
  { keywords: /template/i, toolPrefixes: ["mission_template"] },
  { keywords: /marketplace/i, toolPrefixes: ["marketplace_"] },
  // Rules below back the 2026-07-13 eager-tier demotions (audience-map.ts):
  // each demoted tool stays one keyword away — no tool_search round-trip on
  // the messages that actually name the capability.
  { keywords: /\bchart\b|\bgraph\b|\bplot\b/i, toolPrefixes: ["create_chart"] },
  { keywords: /\bpreview\b/i, toolPrefixes: ["preview_document"] },
  { keywords: /telegram/i, toolPrefixes: ["telegram_"] },
  { keywords: /whats\s*app/i, toolPrefixes: ["whatsapp_"] },
  { keywords: /\brestart\b|\breboot\b/i, toolPrefixes: ["restart"] },
  { keywords: /check.*updates?\b|updates?\s+(the\s+)?(app|yourself)|new version|upgrade/i, toolPrefixes: ["check_for_updates", "apply_update"] },
  { keywords: /\bmcp\b/i, toolPrefixes: ["mcp_add_server"] },
  { keywords: /protocol/i, toolPrefixes: ["protocol"] },
  { keywords: /\bvideo\b/i, toolPrefixes: ["send_video", "generate_video"] },
  { keywords: /secret|api.?key|credential|\btoken\b/i, toolPrefixes: ["request_secret", "list_secrets"] },
  { keywords: /create.*agent|new agent/i, toolPrefixes: ["agent_create"] },
  { keywords: /your logs|read.*logs/i, toolPrefixes: ["read_my_logs"] },
  // Raw-transcript paging (deferred tier — no audience entry): surfaces when
  // the user asks about earlier conversation verbatim or a compacted range.
  { keywords: /\brecall\b|earlier (message|conversation)|what did (i|you) (say|ask)|scroll back/i, toolPrefixes: ["recall"] },
];

/**
 * Detect literal tool-call syntax in the user message and return any
 * exact tool names referenced. Catches the pattern `tool_name({...})` —
 * when the user pastes a tool call directly, we MUST include that tool
 * regardless of keyword filters. Otherwise
 * the model sees "tool not in my schema" and routes to self_edit /
 * tool_search to try to "investigate."
 */
function detectLiteralToolCalls(message: string, allTools: ToolDefinition[]): Set<string> {
  const out = new Set<string>();
  const re = /\b([a-z_][a-z0-9_]+)\s*\(\s*\{/gi;
  const known = new Set(allTools.map(t => t.name));
  let m: RegExpExecArray | null;
  while ((m = re.exec(message)) !== null) {
    if (known.has(m[1])) out.add(m[1]);
  }
  return out;
}

/**
 * Pure keyword router — given a user message + the full tool list,
 * return the set of tool names matched by TOOL_KEYWORD_MAP. Extracted
 * from filterToolsForMessage so resolveToolsForRequest can inject it
 * as a dependency without circular imports.
 */
function keywordRouter(message: string, allTools: ToolDefinition[]): Set<string> {
  const out = new Set<string>();
  for (const { keywords, exclude, toolPrefixes } of TOOL_KEYWORD_MAP) {
    if (keywords.test(message) && !exclude?.test(message)) {
      for (const tool of allTools) {
        for (const prefix of toolPrefixes) {
          if (tool.name.startsWith(prefix) || tool.name === prefix) {
            out.add(tool.name);
          }
        }
      }
    }
  }
  return out;
}

/**
 * Main-chat tool set for a message: the eager main-chat audience plus
 * keyword-routed and literally-called tools (resolveToolsForRequest).
 */
export function filterToolsForMessage(
  allTools: ToolDefinition[],
  message: string,
): ToolDefinition[] {
  return resolveToolsForRequest(
    {
      audience: "main-chat",
      message,
      keywordRouter,
      literalCallDetector: detectLiteralToolCalls,
    },
    allTools,
  );
}
