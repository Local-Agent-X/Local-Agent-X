/**
 * Search-and-cap helpers for large fetched bodies. `findInBody` greps a body
 * for the lines the agent cares about; `capBody` truncates a body that can't be
 * paged (no held copy to offset into — e.g. a live browser extract) with a note
 * that points the agent at its narrowing knob. Oversize web_fetch/http_request
 * bodies spill to disk via result-spill instead of paging here.
 */

/** Cap a body that can't be paged (no held copy to offset into — e.g. a live
 *  browser extract). Truncates with a note that points the agent at `find` to
 *  reach the rest, so it's not the silent dead-end a bare slice was. `hint` names
 *  the tool's own way to narrow (e.g. 'the find param'). */
export function capBody(body: string, maxChars: number, hint: string): string {
  if (body.length <= maxChars) return body;
  return (
    `[Showing the first ${maxChars} of ${body.length} chars — ${hint} to reach the rest.]\n\n` +
    body.slice(0, maxChars)
  );
}

/** Grep-within-body: return the lines matching `find` (case-insensitive
 *  substring) plus `context` lines around each hit, so the agent can pull the
 *  relevant part of a big page instead of paging the whole thing. Substring, not
 *  regex — the model controls the query and regex adds only ReDoS + escaping. */
export function findInBody(
  body: string,
  find: string,
  context = 2,
  maxBlocks = 50,
): { text: string; matchCount: number } {
  const needle = find.toLowerCase();
  if (!needle) return { text: body, matchCount: 0 };
  const lines = body.split("\n");
  const hits: number[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].toLowerCase().includes(needle)) hits.push(i);
  }
  if (hits.length === 0) {
    return { text: `No lines matching "${find}" in ${lines.length} lines.`, matchCount: 0 };
  }
  // Merge overlapping context windows into contiguous ranges.
  const ranges: Array<[number, number]> = [];
  for (const h of hits) {
    const lo = Math.max(0, h - context);
    const hi = Math.min(lines.length - 1, h + context);
    const last = ranges[ranges.length - 1];
    if (last && lo <= last[1] + 1) last[1] = Math.max(last[1], hi);
    else ranges.push([lo, hi]);
  }
  const shown = ranges.slice(0, maxBlocks);
  const blocks = shown.map(([lo, hi]) =>
    `[lines ${lo + 1}-${hi + 1}]\n${lines.slice(lo, hi + 1).join("\n")}`,
  );
  const omitted = ranges.length - shown.length;
  const header =
    `${hits.length} line(s) match "${find}"` +
    (omitted > 0 ? `; showing the first ${shown.length} of ${ranges.length} blocks (${omitted} more — refine the query).` : `.`);
  return { text: `${header}\n\n${blocks.join("\n\n---\n\n")}`, matchCount: hits.length };
}
