// Tiny shared utilities for the Anthropic adapter. All pure — no IO,
// no logging.

import type { TurnInput } from "../../adapter-contract.js";
import type { TransportTool } from "./types.js";

export function convertTools(tools: TurnInput["tools"]): TransportTool[] {
  return tools.map(t => ({
    name: t.name,
    description: t.description ?? "",
    parameters: ((t.inputSchema as Record<string, unknown>) ?? {}),
  }));
}

