// Strip fenced and indented code blocks before running claim detectors.
// Live failure (2026-05-05): user asked "give me a prompt to hand to Claude",
// agent emitted a long markdown response with the prompt inside ``` fences.
// CREATION_HALLUCINATION_RE_2 matches lines starting with "Add/Update/Save/...",
// which fired on bullet lines INSIDE the quoted prompt — content the agent was
// drafting for someone else, not actions it was claiming. Each false hit
// triggered a re-iteration nudge, producing 4 redrafted prompts in one
// response (109k tokens, $0.63). Quoted/code content never represents the
// agent's own first-person claim and must be excluded from detection.

export function stripCodeBlocks(text: string): string {
  if (!text) return text;
  return text
    .replace(/```[\s\S]*?```/g, "")
    .replace(/(^|\n)( {4,}|\t)[^\n]*/g, "$1");
}
