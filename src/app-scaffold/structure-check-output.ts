/**
 * What a passing structure check said that the building agent should still
 * hear: the kit's size check lists what is nearing a cap (its warning band,
 * which never fails). The harness gates (the done-claim gate, the chunk gate)
 * turn that block into one short note for the agent's next turn, so a file is
 * split along a design seam before it hits the cap, not cut to fit at it.
 *
 * The block's shape is the kit script's (kit/check-code-size.mjs): the heading
 * line, then one indented `<item>: <n> [own ]code lines (cap <n>)` line per
 * item, then an indented advice line. structure-check-output.test.ts runs the
 * vendored script, so a change to that shape fails here, not silently.
 */

/** The heading kit/check-code-size.mjs prints above its warning band. */
export const SIZE_WARNING_HEADING = "Nearing the size cap (a warning; it never fails):";

/** Items quoted in the note; the codebase map lists every one. */
const NOTE_ITEMS = 5;
const ITEM = /^\s{2}(\S.*: \d+ (?:own )?code lines \(cap \d+\))$/;

/**
 * The note for a passing check's output, or null when nothing is near a cap.
 * Largest first, as the kit prints them.
 */
export function structureWarningNote(output: string): string | null {
  const lines = output.replace(/\r\n/g, "\n").split("\n");
  const at = lines.findIndex((l) => l.trim() === SIZE_WARNING_HEADING);
  if (at < 0) return null;
  const items: string[] = [];
  for (const line of lines.slice(at + 1)) {
    if (!line.startsWith("  ")) break;
    const m = ITEM.exec(line);
    if (m) items.push(m[1]);
  }
  if (items.length === 0) return null;
  const more = items.length > NOTE_ITEMS ? ` (and ${items.length - NOTE_ITEMS} more in docs/codebase-map.md)` : "";
  return (
    `The structure check passed, but these are nearing the size cap: ${items.slice(0, NOTE_ITEMS).join("; ")}${more}. ` +
    "Before adding to one, find the job that grew in it and move that job into a module named after the job. " +
    "Only code lines count: comments are free, so never delete them to fit, and never name a split after the limit."
  );
}
