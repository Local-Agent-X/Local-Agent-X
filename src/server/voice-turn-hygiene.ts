import { sanitizeModelOutput, stripLeakedSpecialTokensStreaming } from "../providers/output-sanitize.js";
import { categoryOf, isReadOnlyCall } from "../tool-registry.js";

/** Spoken when the degenerate-output guard stops a reply mid-stream. Voice
 *  has no inline-card surface, so a guard stop that would otherwise end in
 *  abrupt silence is voiced instead. */
export const VOICE_GUARD_STOP_NOTICE =
  " Sorry — I started repeating myself there, so I stopped.";

/** Spoken when a lookup starts and the model has said nothing since the last
 *  one, so the user hears that work is happening instead of silence. Keyed by
 *  the tool row's own category: searching the web, looking at the screen, or
 *  anything else read-only (memory, past chats, a job's status). */
const LOOKUP_LINES: Record<"web" | "screen" | "other", readonly string[]> = {
  web: ["Let me look that up. ", "I'll search now. ", "One sec, checking. "],
  screen: ["Let me take a look. ", "One sec, looking. "],
  other: ["Let me check. ", "One sec, let me pull that up. ", "I'll check that. "],
};
const STILL_LOOKING = "Still looking. ";
const MAX_LOOKUP_LINES = 2;

/** The kind of lookup this call is, or null when it is not one: an action
 *  (saving a fact, queueing work, scheduling) needs no "let me check", and
 *  the sphere is decoration, not work. */
function lookupKind(toolName: string, args: Record<string, unknown>): keyof typeof LOOKUP_LINES | null {
  if (toolName === "voice_visual") return null;
  const category = categoryOf(toolName);
  if (category === "computer") return "screen";
  if (!isReadOnlyCall(toolName, args)) return null;
  return category === "research" || category === "browser" ? "web" : "other";
}

let lookupRotation = 0;

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
  private spokeSinceLookup = false;
  private lookupLines = 0;

  /** A model delta arrived. Returns the text TTS should speak, or null when
   *  the delta was junk-only (drop it). Always accumulates the raw delta so
   *  the finalize() pass sees true, uncut model output. */
  delta(rawDelta: string): string | null {
    this.raw += rawDelta;
    const spoken = stripLeakedSpecialTokensStreaming(rawDelta);
    if (spoken.trim().length > 0) this.spokeSinceLookup = true;
    return spoken.length > 0 ? spoken : null;
  }

  /** A tool call started. Returns a short line to speak when the model has
   *  been silent since the turn began or the previous lookup, else null. At
   *  most two per turn; the second says it is still looking. The line enters
   *  the stored text, since the user heard it. */
  lookupStarted(toolName: string, args: Record<string, unknown> = {}): string | null {
    const kind = lookupKind(toolName, args);
    if (kind === null) return null;
    const silent = !this.spokeSinceLookup;
    this.spokeSinceLookup = false;
    if (!silent || this.lookupLines >= MAX_LOOKUP_LINES) return null;
    const lines = LOOKUP_LINES[kind];
    const line = this.lookupLines === 0 ? lines[lookupRotation++ % lines.length] : STILL_LOOKING;
    this.lookupLines++;
    this.raw += line;
    return line;
  }

  /** A line the harness speaks itself (a spoken approval question). It enters
   *  the stored text, since the user heard it. */
  said(line: string): string {
    this.raw += line;
    this.spokeSinceLookup = true;
    return line;
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
