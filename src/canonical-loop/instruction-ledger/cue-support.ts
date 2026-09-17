/**
 * The LLM confirm judges the cues the phrase gate found; it does not get to add
 * a capability class no cue refers to.
 *
 * Aider's retry prompt, "The tests are correct, don't try and change them. Fix
 * the code in wordy.py", tripped the gate on "don't try and change" and the
 * confirm (a 3B background model) returned `shell`. Every bash call in the
 * retry was refused as "the user asked you not to run shell commands", and the
 * model stopped to explain instead of fixing (muse, 2026-09-17). Nothing in the
 * cue is about running anything. Split from extract.ts (file-size gate).
 */
import type { CapabilityClass } from "../../tool-registry.js";

// What each class is about, by the words a cue for it would contain. Broad on
// purpose: this only has to rule out a class the cue cannot mean, not decide
// which one it does mean — that stays the confirm's call.
const CLASS_WORDS: Record<CapabilityClass, RegExp> = {
  "workspace-write": /\b(?:edit|modif|chang|touch|writ|rewrit|delet|remov|renam|refactor|creat|alter|commit|push|save)|read[- ]?only|\b(?:no|zero)\s+changes|\bas[- ]is\b|\balone\b|\buntouched\b/i,
  shell: /\b(?:run|install|command|shell|bash|terminal|script|execut|test|build|compil|lint|commit|push|git|npm|pip|deploy|launch|start)/i,
  egress: /\b(?:brows|browser|web|internet|online|network|fetch|download|url|search|http|curl|api)/i,
  "sensitive-read": /\b(?:read|secret|credential|env\b|password|key|token|private|ssh)/i,
};

// Cues that forbid acting at all; any class may follow from them.
const ACT_NOTHING = /\b(?:do\s+anything|hands[- ]off|(?:just|only)\s+tell\s+me|just\s+(?:look|review|analy[sz]e)|(?:look|review|analysis)\s+only|myself)\b|read[- ]?only/i;

/** Keep only the classes at least one gated cue can refer to. */
export function supportedByCues(prohibitions: readonly CapabilityClass[], cues: readonly string[]): CapabilityClass[] {
  if (cues.some((c) => ACT_NOTHING.test(c))) return [...prohibitions];
  return prohibitions.filter((cls) => cues.some((c) => CLASS_WORDS[cls]?.test(c)));
}
