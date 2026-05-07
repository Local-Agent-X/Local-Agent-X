/**
 * Feature-flag reader for `lax.canonical_loop.{lane}` (PRD §17).
 *
 * Issue 01: env-driven, lane-keyed, default OFF. The flag value is captured
 * once at submission and is immutable for the op's lifetime. This module
 * never reads from disk — callers should snapshot the value on the op at
 * submission time.
 *
 * Env vars (case-insensitive truthy values: "1", "true", "yes", "on"):
 *   LAX_CANONICAL_LOOP_INTERACTIVE
 *   LAX_CANONICAL_LOOP_BUILD
 *   LAX_CANONICAL_LOOP_IDE
 *   LAX_CANONICAL_LOOP_BACKGROUND
 *   LAX_CANONICAL_LOOP_ALL          (catch-all override; ON forces every lane ON)
 *   LAX_CANONICAL_LOOP_CHAT         (opt-in: route chat WS turns through canonical)
 */
import type { CanonicalLane } from "./types.js";

const TRUTHY = new Set(["1", "true", "yes", "on"]);

function readBoolEnv(name: string): boolean {
  const raw = process.env[name];
  if (!raw) return false;
  return TRUTHY.has(raw.trim().toLowerCase());
}

const LANE_ENV: Record<CanonicalLane, string> = {
  interactive: "LAX_CANONICAL_LOOP_INTERACTIVE",
  build: "LAX_CANONICAL_LOOP_BUILD",
  ide: "LAX_CANONICAL_LOOP_IDE",
  background: "LAX_CANONICAL_LOOP_BACKGROUND",
};

export function isCanonicalLoopEnabled(lane: CanonicalLane): boolean {
  if (readBoolEnv("LAX_CANONICAL_LOOP_ALL")) return true;
  const envName = LANE_ENV[lane];
  if (!envName) return false;
  return readBoolEnv(envName);
}

/**
 * Opt-in: when set, the chat WS forward layer creates an `op_chat_turn`
 * canonical op (interactive lane) instead of POSTing to /api/chat. The
 * Anthropic adapter drives the turn end-to-end; chunks stream back via
 * the bus to the WS session. Stays OFF until the chat-canonical bridge is
 * proven against real traffic.
 *
 * Tools are NOT plumbed in Phase 1 — pure-conversational turns work; any
 * tool_call_requested falls into the `NotConfiguredToolDispatcher` and the
 * model sees an error result. Don't flip this on for chats that need tools
 * until the dispatcher bridge lands.
 */
export function isCanonicalChatEnabled(): boolean {
  return readBoolEnv("LAX_CANONICAL_LOOP_CHAT");
}

/** Test helper — read the env var name for a lane. Not for production logic. */
export function envVarForLane(lane: CanonicalLane): string | undefined {
  return LANE_ENV[lane];
}
