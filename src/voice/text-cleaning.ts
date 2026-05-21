// Strip non-speakable formatting (code, URLs, file paths, markdown,
// emojis, escapes) before sending to a TTS engine. The bridge formatter
// (Telegram MarkdownV2) escapes specials with \ — \., \!, \_, \( etc. —
// and SAPI reads each backslash as the literal word "backslash" ("loud and
// clear backslash"). The markdown-char strip below removes the
// underscore/star/etc. but NOT the leading backslash; drop all backslashes
// here so the special char that follows gets pronounced naturally.

export function cleanForTTS(text: string): string {
  let clean = text;

  clean = clean.replace(/```[\s\S]*?```/g, "");                  // code blocks
  clean = clean.replace(/`[^`]+`/g, "");                          // inline code
  clean = clean.replace(/https?:\/\/\S+/g, "");                  // URLs
  clean = clean.replace(/[\w/\\.-]+\.(?:html|js|ts|css|json|md|py|sh)\b/g, ""); // file paths
  clean = clean.replace(/workspace\/\S+/g, "");                  // workspace paths
  clean = clean.replace(/\([^)]{15,}\)/g, "");                   // long parenthetical text (>15 chars)
  clean = clean.replace(/\{[^}]*\}/g, "");                        // JSON/code in braces
  clean = clean.replace(/\[.*?\]\(.*?\)/g, "");                  // markdown links
  clean = clean.replace(/\[\[.*?\]\]/g, "");                      // tags
  clean = clean.replace(/[\u{1F300}-\u{1FAFF}☀-➿⏩-⏺]+/gu, ""); // emojis
  clean = clean.replace(/\\/g, "");                               // backslash escapes
  clean = clean.replace(/[*_`#~>]/g, "");                        // markdown formatting
  clean = clean.replace(/[—–]/g, ", ");                            // dashes → pause
  clean = clean.replace(/\b\d{4,}\b/g, "");                       // long numbers (ports, IDs)
  clean = clean.replace(/[^\x20-\x7E]/g, "");                    // non-printable/non-ASCII
  clean = clean.replace(/\s{2,}/g, " ");                          // collapse whitespace
  clean = clean.replace(/^\s*[-•]\s*/gm, "");                    // bullet points
  clean = clean.replace(/^\s*\d+\.\s*/gm, "");                   // numbered lists

  return clean.trim().slice(0, 2000);
}
