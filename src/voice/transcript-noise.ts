// Whisper noise-annotation hygiene — ONE source of truth for scrubbing the
// stage directions Whisper hallucinates on quiet/cut-off audio before they
// reach the agent or the dictation textarea as if the user said them.
//
// Two shapes exist in the wild:
//   • bracketed: "[BLANK_AUDIO]", "[music]" — stripped ANYWHERE in the text
//     (they can ride alongside real words), including an unclosed trailing
//     "[..." span.
//   • parenthesized / asterisked: "(muffled speaking", "(inaudible)",
//     "*sighs*" — treated as noise only when they are the ENTIRE final, so a
//     legitimate spoken aside ("call John (my brother) tomorrow") survives.
//     Whisper's unclosed variants ("(muffled speaking") count too — that
//     exact form reached the agent as user speech and got a "didn't catch
//     that" reply.
//
// Callers: voice-session turn machine (live voice + dictate) and
// continuous-listen's stt.ts. Extend HERE, not with a second regex.

/** Scrub Whisper noise annotations. Returns "" when nothing real remains —
 *  callers drop the final entirely in that case. */
export function stripTranscriptNoise(text: string): string {
  const trimmed = (text || "").trim();
  if (!trimmed) return "";
  // Whole-final stage direction in parens or asterisks, closed or unclosed.
  if (/^\([^)]*\)?[.…]?$/s.test(trimmed)) return "";
  if (/^\*[^*]*\*?[.…]?$/s.test(trimmed)) return "";
  // Bracketed annotations anywhere; second pass clears an unclosed trailing
  // "[..." so stray bracketed text can't survive (or mimic system notices).
  return trimmed.replace(/\[[^\]]*\]/gs, "").replace(/\[[^\]]*$/s, "").trim();
}
