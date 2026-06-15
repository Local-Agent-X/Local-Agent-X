// Pure prompt-cleaning helpers for scheduled missions. Kept free of the cron
// runtime graph so they can be unit-tested at the seam without dragging in the
// agent loop / security / provider modules.

export const stripCronPreamble = (p: string): string => {
  const patterns = [
    /^every day at \d{1,2}(:\d{2})?\s*(am|pm)?,?\s*/i,
    /^every day,?\s*/i,
    /^daily at \d{1,2}(:\d{2})?\s*(am|pm)?,?\s*/i,
    /^daily,?\s*/i,
    /^at \d{1,2}(:\d{2})?\s*(am|pm)?\s+(every day|daily),?\s*/i,
    /^each (day|morning|evening|night),?\s*/i,
  ];
  let out = p.trim();
  for (const re of patterns) out = out.replace(re, "");
  return out.trim();
};

// Mission prompts often end with a "save to <path>" directive, but cron strips
// the write/edit tools and persists the returned text itself — so the path is
// dead weight that only confuses the agent. Match the WHOLE trailing save
// clause in one shot, to end-of-line. The path can carry spaces inside a
// bracketed placeholder ("[today's date]"), so the old \S+ matchers severed it
// mid-token and left orphans like "Save date].md" that read as a truncated
// task. End-anchored so only a trailing directive is removed, never mid-prompt
// prose; the leading [,.\s]* swallows the separator before it. Verbs are kept
// to ones rare as plain nouns — "store"/"put" are excluded because "retail
// store" / "put together" appear in normal prompts and would over-strip.
const SAVE_VERB = "(?:save|write|export|output|persist)";
const SAVE_INSTRUCTION_PATTERNS = [
  new RegExp(`[,.\\s]*\\b(?:and\\s+)?${SAVE_VERB}\\b[^\\n]*?\\.(?:md|markdown|txt|json|csv|html?|pdf|docx?|xlsx?)\\b[^\\n]*$`, "i"),
  new RegExp(`[,.\\s]*\\b(?:and\\s+)?${SAVE_VERB}\\b[^\\n]*?\\bworkspace\\/[^\\n]*$`, "i"),
];

export const stripSaveInstructions = (p: string): string => {
  let out = p;
  for (const re of SAVE_INSTRUCTION_PATTERNS) out = out.replace(re, "");
  return out.trim();
};
