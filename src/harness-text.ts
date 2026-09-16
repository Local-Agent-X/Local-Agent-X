/**
 * The harness's own text — every marker this system writes into a model's
 * input — in ONE registry, with the boundary rule each one obeys.
 *
 * Why a registry. These markers are written by five subsystems that never talk
 * to each other (the untrusted-content wrapper, the system-prompt notices, the
 * situational digest, the automatic-check nudge, the mid-turn inject frame,
 * the repeated-call short-circuit). Each is scrubbed — or not — by whatever
 * code its author happened to know about. On 2026-09-16 a model quoted its
 * tool results back and a wall of `<<<EXTERNAL_UNTRUSTED_CONTENT id="…">>>`
 * streamed into the user's chat, because the stream scrubber knew about
 * special tokens and nothing had ever taught it about that wrapper. Fixing
 * that one marker in that one scrubber leaves the same hole for the other five
 * and for the next one someone adds.
 *
 * THE RULE, for every entry: harness text may travel INTO the model, and never
 * back OUT of it. A model that echoes one of these is quoting plumbing — never
 * an answer — so assistant text loses it at every boundary that renders or
 * stores it (live stream, delivered reply, persisted transcript).
 *
 * Adding a marker: add it here with a sample. harness-text.contract.test.ts
 * drives every entry through every assistant-text scrubber, so a marker that
 * no scrubber handles fails the build instead of reaching a user's screen.
 */

export interface HarnessMarker {
  id: string;
  /** Matches the marker itself — never the prose around it. */
  pattern: RegExp;
  /** A real instance, as its emitter writes it. Used by the contract test. */
  sample: string;
  /** Who writes it, for the next person who has to change one. */
  emitter: string;
}

export const HARNESS_MARKERS: readonly HarnessMarker[] = [
  {
    id: "untrusted-content-wrapper",
    pattern: /<<<\/?(?:END_)?EXTERNAL_UNTRUSTED_CONTENT(?:\s+id="[^"\n]{0,80}")?>>>/gi,
    sample: '<<<EXTERNAL_UNTRUSTED_CONTENT id="a1b2c3">>>',
    emitter: "sanitize.ts wrapExternalContent",
  },
  {
    id: "untrusted-content-wrapper-close",
    pattern: /<<<END_EXTERNAL_UNTRUSTED_CONTENT(?:\s+id="[^"\n]{0,80}")?>>>/gi,
    sample: '<<<END_EXTERNAL_UNTRUSTED_CONTENT id="a1b2c3">>>',
    emitter: "sanitize.ts wrapExternalContent",
  },
  {
    id: "harness-notice",
    pattern: /\[HARNESS NOTE: [^\]\n]{0,60}\]|\[END HARNESS NOTE\]/g,
    sample: "[HARNESS NOTE: FILE ACCESS]",
    emitter: "context/system-prompt-builder.ts harnessNotice",
  },
  {
    id: "situational-context",
    pattern: /\[SITUATIONAL CONTEXT[^\]\n]{0,200}\]|\[END CONTEXT\]/g,
    sample: "[SITUATIONAL CONTEXT — system-generated, not from the user. Orientation only; never quote or mention this block in your reply.]",
    emitter: "canonical-loop/turn-loop/situational-awareness.ts",
  },
  {
    id: "automatic-check",
    pattern: /\[automatic check\]/gi,
    sample: "[automatic check] 1 tool call in your last turn returned a non-ok status.",
    emitter: "canonical-loop/turn-loop/tool-failure-summary.ts",
  },
  {
    id: "mid-turn-inject-frame",
    pattern: /\[mid-turn user message\]/gi,
    sample: "[mid-turn user message] actually, stop",
    emitter: "canonical-loop/turn-loop/inject-drain.ts",
  },
  {
    id: "repeated-call-short-circuit",
    pattern: /\[REPEATED CALL[^\]\n]{0,200}\]/g,
    sample: "[REPEATED CALL — identical to a tool call made earlier this session. Returning the previous result without re-executing.]",
    emitter: "tool-execution/resolve-tool.ts",
  },
];

/** Strip every harness marker from text the MODEL produced. Prose around a
 *  marker is the model's own and survives. */
export function stripHarnessMarkers(text: string): string {
  if (!text) return text;
  let out = text;
  for (const marker of HARNESS_MARKERS) out = out.replace(marker.pattern, "");
  return out;
}

/** Does this text carry harness plumbing the model echoed back? */
export function containsHarnessMarker(text: string): boolean {
  return HARNESS_MARKERS.some((m) => { m.pattern.lastIndex = 0; return m.pattern.test(text); });
}
