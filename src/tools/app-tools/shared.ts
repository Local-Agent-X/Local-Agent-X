/**
 * Shared helpers for the app-tools modules — the actor they act as, ToolResult
 * shorthand, and the LAX/LAX port lookup repeated across every tool that
 * builds an app URL.
 */

import type { ToolResult } from "../../types.js";

// status:"ok" opts successes into the explicit [ok] header
// (renderToolResultForModel) — bare-prose successes left weaker models
// unsure the action landed, so they re-verified finished work in a loop.
export function ok(content: string): ToolResult { return { content, status: "ok" }; }
export function err(content: string): ToolResult { return { content, isError: true }; }

// Every app-tool call acts as the agent. Nothing stamps another identity, and
// a model's own `_actor` would let it claim the user's access to an app.
export const APP_TOOL_ACTOR = "agent";

export function getAppPort(): number {
  return parseInt(process.env.LAX_PORT ?? "7007", 10);
}
