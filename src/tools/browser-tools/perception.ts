/**
 * Perception actions — read_console / read_network / read_response.
 *
 * Thin dispatch onto the backend's readConsole()/readNetwork()/readResponse()
 * members (src/browser/backend.ts). Console messages, request URLs, and
 * endpoint bodies are page-controlled text, so every report is wrapped as
 * external content (same posture as downloads/snapshot output).
 */

import type { ToolResult } from "../../types.js";
import type { BrowserBackend } from "../../browser/index.js";
import { wrapExternalContent } from "../../sanitize.js";

export async function handleReadConsole(manager: BrowserBackend): Promise<ToolResult> {
  return { content: wrapExternalContent(await manager.readConsole(), "browser.read_console") };
}

export async function handleReadNetwork(manager: BrowserBackend): Promise<ToolResult> {
  return { content: wrapExternalContent(await manager.readNetwork(), "browser.read_network") };
}

export async function handleReadResponse(manager: BrowserBackend, args: Record<string, unknown>): Promise<ToolResult> {
  const url = typeof args.url === "string" ? args.url.trim() : "";
  if (url === "") {
    return { content: "read_response requires a 'url' — use the endpoint URL surfaced by read_network's 'API/data endpoints observed' section." };
  }
  return { content: wrapExternalContent(await manager.readResponse(url), "browser.read_response") };
}
