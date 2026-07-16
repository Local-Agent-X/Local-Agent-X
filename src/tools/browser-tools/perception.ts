/**
 * Perception actions — read_console / read_network.
 *
 * Thin dispatch onto the backend's readConsole()/readNetwork() members
 * (src/browser/backend.ts). Console messages and request URLs are
 * page-controlled text, so both reports are wrapped as external content
 * (same posture as downloads/snapshot output).
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
