// Public types crossing the voice-session boundary. The agent's
// turn-runner closure is plumbed through createVoiceSessionFactory so
// the voice pipeline doesn't depend on the chat or canonical-loop
// directly — the host wires them together at boot.

import type { ChatCompletionMessageParam } from "openai/resources/chat/completions.js";

export interface VoiceTurnInput {
  text: string;
  history: ChatCompletionMessageParam[];
  onDelta: (text: string) => void;
  /** Forwarded by the agent when it calls voice_visual — bridges the
   *  tool's side-effect event back to the WebSocket so the browser can
   *  morph particles. Optional; if omitted the visualizer is silent. */
  onVisual?: (kind: "emoji" | "text" | "shape" | "mood", value: string, durationMs: number) => void;
  signal: AbortSignal;
  sessionId: string;
}

export interface VoiceTurnResult {
  assistantText: string;
  updatedHistory: ChatCompletionMessageParam[];
}

export type VoiceTurnRunner = (input: VoiceTurnInput) => Promise<VoiceTurnResult>;

/** Secret lookup injected from the host (so voice-session doesn't need a
 *  hard dep on the secrets-store module). Returns the decrypted value or
 *  empty string when missing. The cloud STT path needs this — the API
 *  key lives in the encrypted store, not in process.env. */
export type SecretLookup = (name: string) => string;
