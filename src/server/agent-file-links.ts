// Capabilities for workspace files, which the agent origin serves
// (agent-origin.ts). Two of them, so the operator token never rides a /files
// URL and an agent-written document never holds more than the one file it is:
//
//   - The files-link capability lives in the UI. Its /files links carry it to
//     the UI origin's /files redirect, the only place it is accepted.
//   - That redirect hands the agent origin a per-path signature instead. It
//     opens exactly that file, so a document that reads its own URL learns
//     nothing that reaches its siblings.
//
// Both are one-way HMACs of the operator token: they rotate with it and cannot
// be turned back into it.

import { createHmac, timingSafeEqual } from "node:crypto";

const FILES_LINK_LABEL = "lax-files-link-capability:v1";
const FILE_PATH_LABEL = "lax-agent-file:v1\n";

function hmacHex(key: string, data: string): string {
  return createHmac("sha256", key).update(data).digest("hex");
}

function constantTimeEqual(provided: string, expected: string): boolean {
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function deriveFilesLinkCapability(operatorToken: string): string {
  return hmacHex(operatorToken, FILES_LINK_LABEL);
}

export function verifyFilesLinkCapability(operatorToken: string, provided: string): boolean {
  return constantTimeEqual(provided, deriveFilesLinkCapability(operatorToken));
}

/** Signature for one workspace-relative path, as decoded from the request URL. */
export function signAgentFilePath(operatorToken: string, relativePath: string): string {
  return hmacHex(operatorToken, FILE_PATH_LABEL + relativePath);
}

export function verifyAgentFileSignature(operatorToken: string, relativePath: string, provided: string): boolean {
  return constantTimeEqual(provided, signAgentFilePath(operatorToken, relativePath));
}
