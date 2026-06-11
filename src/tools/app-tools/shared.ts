/**
 * Shared helpers for the app-tools modules — actor resolution, ToolResult
 * shorthand, and the LAX/LAX port lookup repeated across every tool that
 * builds an app URL.
 */

import type { ToolResult } from "../../types.js";

// status:"ok" opts successes into the explicit [ok] header
// (renderToolResultForModel) — bare-prose successes left weaker models
// unsure the action landed, so they re-verified finished work in a loop.
export function ok(content: string): ToolResult { return { content, status: "ok" }; }
export function err(content: string): ToolResult { return { content, isError: true }; }

export function getActor(args: Record<string, unknown>): string {
  return String(args._actor || args._agentId || "agent");
}

export function getAppPort(): number {
  return parseInt(process.env.LAX_PORT ?? "7007", 10);
}
