import { sanitizeModelOutput, stripLeakedSpecialTokensStreaming } from "../providers/output-sanitize.js";

/** Spoken when the degenerate-output guard stops a local reply mid-stream.
 *  Voice has no inline-card surface, so a guard stop that would otherwise end
 *  in abrupt silence is voiced instead. */
export const VOICE_GUARD_STOP_NOTICE =
  " Sorry — my local model glitched there, so I stopped early.";

/**
 * Accumulates a voice turn's model output with delivery + persist hygiene.
 *
 * Live deltas get the cheap, stateless streaming special-token strip before
 * they reach the speaker (a junk-only delta is dropped, never fed as ""). The
 * full whole-document pass — which needs cross-delta context a single delta
 * lacks — runs once at finalize() over the RAW accumulation, producing the
 * text stored in the durable transcript. This mirrors the text-chat delivery
 * seam (routes/chat/run-chat-turn/event-wiring.ts): TTS hears the streaming
 * subset, the transcript stores the full pass.
 */
export class VoiceTurnHygiene {
  private raw = "";

  /** A model delta arrived. Returns the text TTS should speak, or null when
   *  the delta was junk-only (drop it). Always accumulates the raw delta so
   *  the finalize() pass sees true, uncut model output. */
  delta(rawDelta: string): string | null {
    this.raw += rawDelta;
    const spoken = stripLeakedSpecialTokensStreaming(rawDelta);
    return spoken.length > 0 ? spoken : null;
  }

  /** The stream guard stopped a degenerate reply. Returns the notice to speak;
   *  it also enters the stored text so the transcript records the cutoff. */
  guardStopped(): string {
    this.raw += VOICE_GUARD_STOP_NOTICE;
    return VOICE_GUARD_STOP_NOTICE;
  }

  /** The persisted transcript text: the full persist-profile pass over the raw
   *  accumulation, trimmed. */
  finalize(): string {
    return sanitizeModelOutput(this.raw, "persist").trim();
  }
}
