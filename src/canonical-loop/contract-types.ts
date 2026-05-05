/**
 * Value-shape types referenced by the adapter contract.
 *
 * Split from adapter-contract.ts so the contract file stays small and
 * imports cleanly. These are the canonical shapes for messages, tool calls,
 * tool descriptors, and the redirect instruction.
 */

// Re-export of the canonical types defined in types.ts so the adapter
// contract has a single import surface.
export type {
  ProviderStateEnvelope,
  RedirectInstruction,
  CanonicalMessageRole,
} from "./types.js";

import type { CanonicalMessageRole } from "./types.js";

/**
 * Canonical message — append-only row in op_messages, also the replay shape
 * adapters receive on resume. Role is from the locked v1 enum.
 */
export interface CanonicalMessage {
  messageId: string;
  role: CanonicalMessageRole;
  content: unknown;
  /** Optional pointer back to the (op_id, turn_idx) where this message was finalized. */
  turnIdx?: number;
  seqInTurn?: number;
  createdAt?: string;
}

/**
 * One tool invocation requested by the model. The loop dispatches via
 * tool-executor.ts and returns the result as a `tool_result` message in
 * the next turn's input.
 */
export interface ToolCall {
  toolCallId: string;
  tool: string;
  args: unknown;
}

/**
 * Tool advertised to the model for a given turn. Shape kept minimal so
 * adapters can inflate it however their provider expects.
 */
export interface ToolDescriptor {
  name: string;
  description?: string;
  inputSchema?: unknown;
}
