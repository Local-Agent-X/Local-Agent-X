import type { ToolDefinition, ServerEvent } from "../types.js";
import type { SecurityLayer } from "../security.js";
import type { ToolPolicy } from "../tool-policy.js";
import type { ThreatEngine } from "../threat-engine.js";
import type { RBACManager, Role } from "../rbac.js";

export interface ImageAttachment {
  url: string;
  filePath?: string;
  name: string;
}

export interface AgentOptions {
  apiKey: string;
  model: string;
  baseURL?: string;
  provider: "xai" | "openai" | "codex" | "anthropic" | "local" | "gemini" | "custom";
  systemPrompt: string;
  tools: ToolDefinition[];
  security: SecurityLayer;
  toolPolicy?: ToolPolicy;
  threatEngine?: ThreatEngine;
  rbac?: RBACManager;
  callerRole?: Role;
  sessionId?: string;
  maxIterations?: number;
  temperature?: number;
  images?: ImageAttachment[];
  onEvent?: (event: ServerEvent) => void;
  signal?: AbortSignal;
  pauseCallback?: (reason: string) => Promise<string>;
}
