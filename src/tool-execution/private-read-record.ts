// Which successful reads put the user's private content in front of the model:
// an email body, or a document from the user's own folders (Documents,
// Desktop, Downloads, OneDrive). The agent's workspace is excluded even when
// it sits inside Documents, as it does in the packaged app: those are the
// agent's working files, and counting them would prompt on every deploy.
// Recorded by fingerprint into data-lineage/private-content.ts; the send-side
// check is private-content-gate.ts.

import { homedir } from "node:os";
import type { ToolResult } from "../types.js";
import { addressesIn, recordPrivateRead } from "../data-lineage/private-content.js";
import { TOOL_PATH_ARGS } from "../tool-registry.js";
import { resolveAgentPath } from "../workspace/paths.js";
import { workspaceRoot } from "../config.js";
import { pathIsWithin, userContentDirs } from "../security/layer/file-access.js";

const EMAIL_READS: ReadonlySet<string> = new Set(["email_read", "email_search", "email_read_message"]);

/** The user's own document a read named, or null. Respects action-scoped path specs. */
function personalDocumentRead(toolName: string, args: Record<string, unknown>, sessionId: string): string | null {
  const specs = TOOL_PATH_ARGS[toolName];
  if (!specs) return null;
  const action = String(args.action ?? "");
  for (const spec of specs) {
    if (spec.action !== "read" || spec.json) continue;
    if (spec.forActions && !spec.forActions.includes(action)) continue;
    const doc = personalDocumentPath(args[spec.arg], sessionId);
    if (doc) return doc;
  }
  return null;
}

/** The resolved path when `raw` names a document in the user's own folders
 *  (outside the agent's workspace), or null. Also how a send's attachments
 *  are judged: attaching a document sends it whether or not it was read. */
export function personalDocumentPath(raw: unknown, sessionId: string): string | null {
  if (typeof raw !== "string" || !raw) return null;
  const path = resolveAgentPath(raw, sessionId);
  if (pathIsWithin(workspaceRoot(), path)) return null;
  return userContentDirs(homedir()).some((dir) => pathIsWithin(dir, path)) ? path : null;
}

export function recordPrivateReadFromResult(
  sessionId: string,
  toolName: string,
  args: Record<string, unknown>,
  result: ToolResult | undefined,
  deliveredChars: number,
): void {
  if (!result || result.isError || typeof result.content !== "string" || !result.content) return;
  const content = result.content.slice(0, deliveredChars);
  if (EMAIL_READS.has(toolName)) {
    // Only a single message names who already holds it; a search or inbox
    // listing mixes many senders, and trusting all of them would trust the
    // sender of an injected email too.
    const correspondents = toolName === "email_read_message" ? addressesIn(content) : [];
    recordPrivateRead(sessionId, { label: "an email you read", correspondents }, content);
    return;
  }
  const doc = personalDocumentRead(toolName, args, sessionId);
  if (doc) recordPrivateRead(sessionId, { label: doc, key: doc }, content);
}
