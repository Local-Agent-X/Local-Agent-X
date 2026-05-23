/**
 * Shared helpers for the app-tools modules — actor resolution, ToolResult
 * shorthand, and the LAX/SAX port lookup repeated across every tool that
 * builds an app URL.
 */

import type { ToolResult } from "../types.js";

export function ok(content: string): ToolResult { return { content }; }
export function err(content: string): ToolResult { return { content, isError: true }; }

export function getActor(args: Record<string, unknown>): string {
  return String(args._actor || args._agentId || "agent");
}

export function getAppPort(): number {
  return parseInt(process.env.LAX_PORT ?? process.env.SAX_PORT ?? "7007", 10);
}
