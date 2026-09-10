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

// Defensive on getCurrentUrl (required on the real interface, but test
// doubles / a future backend variant may not implement it) — mirrors the
// guard shared.ts already uses for the same reason.
function currentUrlMeta(manager: BrowserBackend): Record<string, string> | undefined {
  try {
    const url = manager.getCurrentUrl?.();
    return url ? { url } : undefined;
  } catch {
    return undefined;
  }
}

export async function handleReadConsole(manager: BrowserBackend): Promise<ToolResult> {
  return { content: wrapExternalContent(await manager.readConsole(), "browser.read_console", currentUrlMeta(manager)) };
}

export async function handleReadNetwork(manager: BrowserBackend): Promise<ToolResult> {
  return { content: wrapExternalContent(await manager.readNetwork(), "browser.read_network", currentUrlMeta(manager)) };
}

export async function handleReadResponse(manager: BrowserBackend, args: Record<string, unknown>): Promise<ToolResult> {
  const url = typeof args.url === "string" ? args.url.trim() : "";
  if (url === "") {
    return { content: "read_response requires a 'url' — use the endpoint URL surfaced by read_network's 'API/data endpoints observed' section." };
  }
  // The endpoint's own URL, not the page's — a page on a real domain can
  // still proxy/fetch an internal loopback API and vice versa.
  return { content: wrapExternalContent(await manager.readResponse(url), "browser.read_response", { url }) };
}
