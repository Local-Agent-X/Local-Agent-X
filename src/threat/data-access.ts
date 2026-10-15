// What a tool call means to the exfil analyzer: a SOURCE that may surface
// sensitive data, a WRITE to the workspace, or an off-box SINK. Each role is a
// registry capability class (tool-registry.ts), never a list of tool names, so
// a registered synonym (grep, ari_file, edit_lines, ari_http, email_send) or a
// tool added to a class later is tracked the day it joins the class. Which
// argument carries a path is the policy table's pathArgs (TOOL_PATH_ARGS);
// what a sink puts on the wire is egressPayload (tool-execution/egress-payload.ts).

import type { DataClassification } from "./classification.js";
import { isSensitivePath, sensitivePathsReadByCommand } from "../data-lineage/index.js";
import { hasCapability, TOOL_PATH_ARGS } from "../tool-registry.js";
import { declaredPaths } from "../security/layer/runtime-state.js";

/** The kinds of source an exfil pattern is attributed to (and the trust
 *  ledger's fingerprint prefix): a read that names a path, a shell command,
 *  or a read of an owned store with no path to judge (mailbox, memory, db). */
export const SOURCE_KINDS = ["file_read", "shell", "record_read"] as const;
export type SourceKind = typeof SOURCE_KINDS[number];

/** What data a tool call touched */
export interface DataAccess {
  /** A SourceKind, "file_write", or — for an off-box sink — the egress tool's name. */
  type: string;
  target: string;       // file path, URL, command, etc.
  sensitive: boolean;    // classified as sensitive by data classifier
  timestamp: number;
}

export function isSourceKind(type: string): type is SourceKind {
  return (SOURCE_KINDS as readonly string[]).includes(type);
}

/** A type a persisted history entry may carry. */
export function isAccessType(type: string): boolean {
  return isSourceKind(type) || type === "file_write" || hasCapability(type, "egress");
}

/** The paths this call names under its declared path args, split by whether
 *  the spec opens them for reading. Action-scoped specs (ari_file) count only
 *  for the call's own action. */
function declaredCallPaths(toolName: string, args: Record<string, unknown>): { reads: string[]; writes: string[] } {
  const action = String(args.action ?? "");
  const out = { reads: [] as string[], writes: [] as string[] };
  for (const spec of TOOL_PATH_ARGS[toolName] ?? []) {
    if (spec.forActions && !spec.forActions.includes(action)) continue;
    (spec.action === "read" ? out.reads : out.writes).push(...(declaredPaths(args, spec) ?? []));
  }
  return out;
}

/** Does a shell command READ sensitive data? A credential-file operand of a
 *  command whose output can carry its bytes (the same argv walk the taint
 *  policy uses), or a read verb over /etc or the registry. */
function isCommandSensitive(command: string): boolean {
  const c = command.toLowerCase();
  if (sensitivePathsReadByCommand(command).length > 0) return true;
  return /\b(cat|type|more|less|head|tail|get-content)\b/.test(c) && (/\/etc\//.test(c) || /registry/.test(c));
}

/** Classify one tool call, or null when it is in none of the tracked classes.
 *  Sensitive by CONTENT (the result's classification) or by SOURCE: a declared
 *  read path that is sensitive, a shell command that reads one, or any read of
 *  an owned store — with no path to judge, its records are presumed sensitive. */
export function classifyAccess(
  toolName: string,
  args: Record<string, unknown>,
  classification: DataClassification,
): DataAccess | null {
  const contentSensitive = classification.labels.length > 0;
  const timestamp = Date.now();
  if (hasCapability(toolName, "egress")) {
    return { type: toolName, target: typeof args.url === "string" ? args.url : "", sensitive: contentSensitive, timestamp };
  }
  const paths = declaredCallPaths(toolName, args);
  const shell = hasCapability(toolName, "shell");
  if ((hasCapability(toolName, "sensitive-read") || shell) && paths.writes.length === 0) {
    if (shell) {
      const command = String(args.command ?? "");
      return { type: "shell", target: command || toolName, sensitive: contentSensitive || isCommandSensitive(command), timestamp };
    }
    if (TOOL_PATH_ARGS[toolName]) {
      const sensitive = contentSensitive || paths.reads.some((p) => isSensitivePath(p));
      return { type: "file_read", target: paths.reads[0] ?? toolName, sensitive, timestamp };
    }
    return { type: "record_read", target: toolName, sensitive: true, timestamp };
  }
  if (hasCapability(toolName, "workspace-write")) {
    return { type: "file_write", target: paths.writes[0] ?? toolName, sensitive: contentSensitive, timestamp };
  }
  return null;
}
