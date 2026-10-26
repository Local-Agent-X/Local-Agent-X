/**
 * http_request's `body_file`: send a file's contents as the request body,
 * as-is or as one JSON field (`body_file_field: "query"` → {"query": "<file>"}).
 *
 * Without it, sending a file meant pasting it into `body` by hand: on
 * 2026-10-25 a 9.7 KB migration went to a production database retyped token by
 * token, because the shell route (read the file, POST it) is rightly blocked
 * for raw network access. The file is the policy row's declared read path, so
 * the file-access gate confines it and the private-content gate counts it as
 * an attachment, like an email attachment; the outbound scan reads the body
 * this builds (http-request.ts).
 *
 * `{{SECRET}}` placeholders inside the file are never resolved: a file the
 * agent downloaded must not be able to pull a vault secret into a request.
 * Only the model-written `body` and headers bind secrets.
 */
import { readValidatedFile } from "../security/layer/index.js";
import { resolveAgentPath } from "../workspace/paths.js";

const MAX_BODY_FILE_BYTES = 10 * 1024 * 1024;

export type BodyFromFile = { body: string } | { error: string };

export function bodyFromFile(args: Record<string, unknown>, sessionId: string | undefined): BodyFromFile | null {
  if (typeof args.body_file !== "string" || !args.body_file.trim()) return null;
  if (args.body !== undefined && args.body !== null && args.body !== "") {
    return { error: "Pass the body either inline (`body`) or from a file (`body_file`), not both." };
  }
  let data: Buffer;
  try {
    data = readValidatedFile(resolveAgentPath(args.body_file, sessionId), sessionId);
  } catch (e) {
    return { error: `Could not read body_file ${args.body_file}: ${(e as Error).message}` };
  }
  if (data.length > MAX_BODY_FILE_BYTES) return { error: `body_file is ${data.length} bytes; the limit is ${MAX_BODY_FILE_BYTES}.` };
  const text = data.toString("utf-8");
  const field = typeof args.body_file_field === "string" ? args.body_file_field.trim() : "";
  return { body: field ? JSON.stringify({ [field]: text }) : text };
}
