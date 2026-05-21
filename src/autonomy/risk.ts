/**
 * ToolRisk — risk classification for tool calls.
 *
 * Stub placeholder. Full implementation owned by Prompt 1 (peer working
 * in parallel). This file declares the type that profiles.ts depends on
 * so tsc stays clean during parallel development. Peer's risk.ts will
 * replace this with the classification table + classifier function.
 */

export type ToolRisk =
  | "safe"
  | "workspace-write"
  | "network-read"
  | "network-write"
  | "shell"
  | "external-comms"
  | "destructive"
  | "money"
  | "secrets";
