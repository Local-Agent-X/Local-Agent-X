import { sanitizeModelOutput, stripLeakedSpecialTokensStreaming } from "../providers/output-sanitize.js";
import { categoryOf, isReadOnlyCall, toolsTagged } from "../tool-registry.js";

/** Spoken when the degenerate-output guard stops a reply mid-stream. Voice
 *  has no inline-card surface, so a guard stop that would otherwise end in
 *  abrupt silence is voiced instead. */
export const VOICE_GUARD_STOP_NOTICE =
  " Sorry — I started repeating myself there, so I stopped.";

/** Spoken when a lookup starts and the model has said nothing since the last
 *  one, so the user hears that work is happening instead of silence. Each
 *  line says what is being looked at. Generic ones ("Let me check.", "Still
 *  looking.") answered "we already had this talk" as if a lookup were the
 *  point, and ran straight into "I don't have his email" (2026-11-11). */
const LOOKUP_LINES = {
  chats: "looking back through our chats",
  notes: "checking my notes",
  email: "checking your email",
  web: "searching the web",
  screen: "taking a look at your screen",
  files: "looking through your files",
  other: "pulling that up",
} as const;
type LookupKind = keyof typeof LOOKUP_LINES;
const MAX_LOOKUP_LINES = 2;

/** What a call looks at, or null when it is not a lookup: an action (saving
 *  a fact, queueing work, scheduling) needs no line, and the sphere is
 *  decoration, not work. */
function lookupKind(toolName: string, args: Record<string, unknown>): LookupKind | null {
  if (toolName === "voice_visual") return null;
  const category = categoryOf(toolName);
  if (category === "computer") return "screen";
  if (!isReadOnlyCall(toolName, args)) return null;
  if (toolName === "search_past_sessions") return "chats";
  if (toolName.startsWith("email_")) return "email";
  if (category === "research" || category === "browser") return "web";
  if (toolsTagged("memory-search").includes(toolName)) return "notes";
  if (toolsTagged("web-search", "web-read", "web-browse").includes(toolName)) return "web";
  if (toolsTagged("file-read", "file-search").includes(toolName)) return "files";
  return "other";
}

const sentence = (phrase: string): string => `${phrase[0].toUpperCase()}${phrase.slice(1)}. `;

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
  private lastLookup: LookupKind | null = null;

  /** A model delta arrived. Returns the text TTS should speak, or null when
   *  the delta was junk-only (drop it). Always accumulates the raw delta so
   *  the finalize() pass sees true, uncut model output. */
  delta(rawDelta: string): string | null {
    this.raw += rawDelta;
    const spoken = stripLeakedSpecialTokensStreaming(rawDelta);
    if (spoken.trim().length > 0) this.spokeSinceLookup = true;
    return spoken.length > 0 ? spoken : null;
  }

  /** A tool call started. Returns a short line naming what it looks at, when
   *  the model has been silent since the turn began or the previous lookup,
   *  else null. At most two per turn; the second ("Now …") only when it looks
   *  somewhere new. The line enters the stored text, since the user heard it. */
  lookupStarted(toolName: string, args: Record<string, unknown> = {}): string | null {
    const kind = lookupKind(toolName, args);
    if (kind === null) return null;
    const silent = !this.spokeSinceLookup;
    this.spokeSinceLookup = false;
    const previous = this.lastLookup;
    this.lastLookup = kind;
    if (!silent || this.lookupLines >= MAX_LOOKUP_LINES || kind === previous) return null;
    const line = this.lookupLines === 0 ? sentence(LOOKUP_LINES[kind]) : sentence(`now ${LOOKUP_LINES[kind]}`);
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
