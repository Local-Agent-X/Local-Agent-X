// Tiny shared utilities for the Anthropic adapter. All pure — no IO,
// no logging. Used by both the orchestrator and the stream-consume loop.

import type { TurnInput } from "../../adapter-contract.js";
import type { TransportTool } from "./types.js";

export function convertTools(tools: TurnInput["tools"]): TransportTool[] {
  return tools.map(t => ({
    name: t.name,
    description: t.description ?? "",
    parameters: ((t.inputSchema as Record<string, unknown>) ?? {}),
  }));
}

export function parseArgs(raw: string): unknown {
  if (!raw) return {};
  try { return JSON.parse(raw); } catch { return { _raw: raw }; }
}

export function byteLengthUtf8(s: string): number {
  let len = 0;
  for (let i = 0; i < s.length; i++) {
    const code = s.charCodeAt(i);
    if (code < 0x80) len += 1;
    else if (code < 0x800) len += 2;
    else if (code >= 0xd800 && code <= 0xdbff) { len += 4; i++; }
    else len += 3;
  }
  return len;
}

/**
 * Best-effort secret redaction for transport-error messages. Provider
 * errors should never include the bearer token, but we belt-and-suspender
 * by stripping recognized prefixes if they ever leak in. Anything we
 * can't classify cheaply is left alone — the canonical contract requires
 * NO raw secrets in events, but the production transport already filters
 * upstream; this is a defensive last line.
 */
export function redactSecrets(s: string): string {
  if (!s) return s;
  return s
    .replace(/sk-ant-[a-zA-Z0-9_\-]+/g, "[REDACTED_API_KEY]")
    .replace(/sk-ant-oat[a-zA-Z0-9_\-]+/g, "[REDACTED_OAUTH]")
    .replace(/oauth:[a-zA-Z0-9_\-\.]+/g, "[REDACTED_OAUTH]")
    .replace(/Bearer\s+[a-zA-Z0-9_\-\.]+/gi, "Bearer [REDACTED]");
}
