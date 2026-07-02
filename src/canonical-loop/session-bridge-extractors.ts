/**
 * op_messages scanner helpers for the session-bridge observer.
 *
 * These read an op's persisted messages (via the canonical readOpMessages)
 * and pull user-surfaceable bits out of them — the final assistant text a
 * delegating parent needs, plus the "Open" affordance markers (APP_READY,
 * "Created <path>", etc.) the AGENTS sidebar renders. Split out of
 * session-bridge-observer.ts to keep that module under the source-hygiene
 * LOC gate; behavior is unchanged. Depends only on the canonical op_messages
 * reader and content extractor — no observer/bridge deps.
 */
import { readOpMessages } from "./store.js";
import { extractText } from "./turn-loop/content-extract.js";

// Strip trailing chars that are never valid URL tails — bold/italic markdown
// (`**`, `*`, `_`), sentence punctuation, closing brackets. Live failure
// 2026-05-23: agent emitted `**APP_READY: <url>**`, regex captured the
// trailing `**`, the rendered sidebar link 404'd while the apps-page link
// worked.
function trimUrlNoise(url: string): string {
  return url.replace(/[*)\]>.,;:'"`!?]+$/, "");
}

/** Scan an op's persisted messages for the final assistant turn and
 *  pull out the APP_READY: <url> marker the build_app adapter emits.
 *  Returns the URL string, or undefined if the marker isn't present. */
export function extractAppReadyUrl(opId: string): string | undefined {
  try {
    const messages = readOpMessages(opId);
    for (let i = messages.length - 1; i >= 0; i--) {
      const m = messages[i];
      if (m.role !== "assistant") continue;
      const content = m.content as { text?: string } | string | undefined;
      const text = typeof content === "string" ? content : content?.text;
      if (!text) continue;
      const match = text.match(/APP_READY:\s*(\S+)/);
      if (match) return trimUrlNoise(match[1]);
      return undefined;
    }
  } catch { /* malformed op-messages — return undefined */ }
  return undefined;
}

/** Scan an op's persisted tool_result messages for "Created <path>" /
 *  "Wrote ... to <path>" markers from the artifact-creating tools
 *  (the document, presentation, pdf, and spreadsheet tools,
 *  write, create_page, etc.). Returns the MOST RECENT openable artifact's
 *  workspace-relative path, or undefined if none found. Strict
 *  workspace-only filter — host paths outside the workspace are skipped
 *  so the sidebar never offers a link the static handler can't serve.
 *
 *  Used by the generic completion path: any worker op (not just
 *  app_build) gets the same "↗ Open" affordance in the AGENTS sidebar.
 *  The user's framing: "any agent creation wired into that — apps,
 *  landing pages, ppt, docs everything." This is the same wiring,
 *  just with a broader marker set.
 */
export function extractArtifactUrl(opId: string, workspaceDir: string): string | undefined {
  try {
    const messages = readOpMessages(opId);
    // Walk newest-first; first hit wins. Tool outputs we recognize:
    //   "Created /abs/path/foo.docx (...)"           → document, presentation, pdf, spreadsheet
    //   "Wrote N bytes to /abs/path/foo.html"        → write
    //   "Edited /abs/path/foo.css"                   → edit
    //   "App built ... Open: http://127.0.0.1:.../" → build_app (separate APP_READY path also works)
    // We deliberately don't try to extract from prose — only from
    // structured tool_result strings, which are stable.
    const wsAbs = workspaceDir.endsWith("/") ? workspaceDir : workspaceDir + "/";
    for (let i = messages.length - 1; i >= 0; i--) {
      const m = messages[i];
      if (m.role !== "tool_result") continue;
      const content = m.content as { text?: string; result?: string } | string | undefined;
      const text = typeof content === "string"
        ? content
        : (content?.result ?? content?.text ?? "");
      if (!text) continue;
      // Most precise: a build_app-style explicit URL line.
      const urlMatch = String(text).match(/Open:\s*(https?:\/\/\S+)/);
      if (urlMatch) return trimUrlNoise(urlMatch[1]);
      // Generic "Created <abs-path>" / "Wrote N bytes to <abs-path>" patterns.
      const created = String(text).match(/(?:Created|Wrote (?:\d+ bytes? )?to|Edited)\s+(\/\S+)/);
      if (!created) continue;
      const absPath = trimUrlNoise(created[1]);
      // Workspace-bound only — sidebar links go through the static handler.
      if (!absPath.startsWith(wsAbs)) continue;
      const rel = absPath.slice(wsAbs.length);
      // For HTML/index files we want the directory link, not the file.
      if (rel.endsWith("/index.html")) return "/apps/" + rel.slice(0, -"/index.html".length) + "/";
      // /apps/ static handler serves anything under workspace/apps/ — for
      // standalone workspace files (workspace/foo.docx) link via a
      // /workspace/ path. The handler may not serve all of these yet, but
      // the link IS a stable user-readable hint at where the artifact
      // landed; click-through works for HTML, downloads otherwise.
      return rel.startsWith("apps/") ? "/" + rel : "/workspace/" + rel;
    }
  } catch { /* malformed op-messages — return undefined */ }
  return undefined;
}

/** Read an op's persisted messages and return the text of its FINAL assistant
 *  turn — the worker's actual result/answer — truncated to `maxChars`. This is
 *  the piece a delegating parent needs surfaced: op_wait, op_status, and the
 *  completion notification all reuse it instead of a content-free
 *  "task completed". Walks newest-first for the most recent assistant turn that
 *  carries text (a pure tool-call turn has none), reusing the canonical
 *  op_messages reader (readOpMessages) and the canonical content extractor
 *  (extractText) — no bespoke op_messages parsing. Returns "" when there's no
 *  assistant text to show. */
export function extractFinalAssistantText(opId: string, maxChars = 2000): string {
  try {
    const messages = readOpMessages(opId);
    for (let i = messages.length - 1; i >= 0; i--) {
      const m = messages[i];
      if (m.role !== "assistant") continue;
      const text = extractText(m.content).trim();
      if (!text) continue; // pure tool-call turn — keep looking for the last texted one
      return text.length > maxChars ? text.slice(0, maxChars).trimEnd() + "…" : text;
    }
  } catch { /* malformed op-messages — nothing to surface */ }
  return "";
}
