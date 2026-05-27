import type { ToolDefinition } from "../types.js";
import { resolveToolsForRequest } from "../tool-search.js";

// ── Smart Tool Filtering ──
// Always include core tools. Add extras if the user's message hints at them.
// tool_search is always included so the agent can discover anything else.

// Audience mapping (which tools are eager for which audience) is owned by
// src/tools/audience-map.ts. This file owns the keyword router, build-intent
// regex, and literal-tool-call detector — all of which the main-chat resolver
// injects into resolveToolsForRequest.

// Keywords that trigger including specific tool groups
const TOOL_KEYWORD_MAP: Array<{ keywords: RegExp; toolPrefixes: string[] }> = [
  { keywords: /spreadsheet|excel|xlsx|csv|sheet/i, toolPrefixes: ["spreadsheet_"] },
  { keywords: /\bdocs?\b|document|docx|\bword\b/i, toolPrefixes: ["document_"] },
  { keywords: /presentation|slide|pptx|powerpoint/i, toolPrefixes: ["presentation_"] },
  { keywords: /pdf/i, toolPrefixes: ["pdf_"] },
  { keywords: /email|mail|inbox|send.*email/i, toolPrefixes: ["email_"] },
  { keywords: /calendar|event|meeting|schedule.*event/i, toolPrefixes: ["calendar_"] },
  { keywords: /clipboard|copy|paste/i, toolPrefixes: ["clipboard_"] },
  { keywords: /sql|database|query.*table|postgres|sqlite/i, toolPrefixes: ["sql_"] },
  { keywords: /image|photo|generate.*image|draw|picture/i, toolPrefixes: ["generate_image", "generate_video", "ocr"] },
  { keywords: /camera|webcam/i, toolPrefixes: ["camera_"] },
  // App tools surface on "app/dashboard/tracker" mentions. Sidebar tools are a
  // SEPARATE rule that requires an explicit sidebar/pin/unpin keyword — the
  // old combined rule was the root cause of Codex reflexively pinning apps
  // to the sidebar whenever the user said anything with "app" in it (e.g.
  // "use this image as the background for my to-do app" → model sees
  // sidebar_pin available + description says "use when user says add" →
  // misroutes to pin).
  { keywords: /\bapp\b|dashboard|tracker/i, toolPrefixes: ["app_"] },
  { keywords: /\bsidebar\b|\bpin\b|\bunpin\b/i, toolPrefixes: ["sidebar_"] },
  { keywords: /issue|ticket|project|kanban/i, toolPrefixes: ["issue_"] },
  { keywords: /instagram|twitter|tiktok|social|post on/i, toolPrefixes: ["mission_"] },
  { keywords: /config|setting/i, toolPrefixes: ["config_"] },
  { keywords: /skill/i, toolPrefixes: ["skill_"] },
  { keywords: /rollback|undo.*mission/i, toolPrefixes: ["mission_rollback_"] },
  { keywords: /chain|pipeline/i, toolPrefixes: ["mission_chain_"] },
  { keywords: /template/i, toolPrefixes: ["mission_template"] },
  { keywords: /marketplace/i, toolPrefixes: ["marketplace_"] },
];

// Build-intent narrowing fires when the user asks to build/create an app —
// the resolver swaps main-chat audience for the smaller build-intent set so
// Codex doesn't choke on the full inventory. Membership lives in audience-map.ts.
const BUILD_INTENT_REGEX = /\b(build|create|make|write|generate|scaffold|set up)\s+(me\s+)?(a\s+|an\s+|the\s+)?(app|bot|dashboard|tracker|tool|game|website|page|site|form|calculator|chat|api|script)/i;

/**
 * Detect literal tool-call syntax in the user message and return any
 * exact tool names referenced. Catches the pattern `tool_name({...})` —
 * when the user pastes a tool call directly, we MUST include that tool
 * regardless of keyword filters or build-intent strip-down. Otherwise
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
  for (const { keywords, toolPrefixes } of TOOL_KEYWORD_MAP) {
    if (keywords.test(message)) {
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
 * Back-compat shim. Delegates to resolveToolsForRequest with
 * audience="main-chat" and the keyword/literal/build-intent helpers
 * wired in. Keeps existing callers working during P1.C3/C4 migration.
 *
 * Verified byte-identical to the pre-migration implementation for the
 * 10 representative messages in test/tool-filter-parity.test.ts.
 */
export function filterToolsForMessage(
  allTools: ToolDefinition[],
  message: string,
  opts?: { forceBuildIntent?: boolean },
): ToolDefinition[] {
  return resolveToolsForRequest(
    {
      audience: "main-chat",
      message,
      keywordRouter,
      literalCallDetector: detectLiteralToolCalls,
      // forceBuildIntent comes from the LLM classifier verdict in
      // prepare-request.ts. Regex alone misses phrasings like
      // "build a log counting app" (modifiers between article and noun)
      // — the classifier handles those, then short-circuits the regex.
      buildIntentTest: (m) => opts?.forceBuildIntent === true || BUILD_INTENT_REGEX.test(m),
    },
    allTools,
  );
}
