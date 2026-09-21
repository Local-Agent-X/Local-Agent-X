/**
 * Tools that must travel together, because one of them makes a PROMISE the
 * other keeps.
 *
 * `delete_file`'s result text tells the user their file went to the trash and
 * can be brought back; `restore_file` is what brings it back. audience-map.ts
 * says so in a comment — "wherever that text can appear the tool must be
 * resolvable" — and enforces it only by giving the two the same audience. The
 * tier CAP is a different filter, and the comment's promise never reached it.
 *
 * Measured 2026-09-21 (EXP-7, qwen3.6:27b): with the cap applied after the
 * tool-index re-rank, `delete_file` survived and `restore_file` did not. The
 * model deleted the same three client originals as before and recovered none
 * of them — `unsafe_action` 0 → 2 — not because it chose differently, but
 * because the undo it had used three times in the baseline was no longer in
 * its schema. EXP-5's entire recovery mechanism, removed by a size limit.
 *
 * So the relation is data, not prose, and the cap resolves it. Companions ride
 * OUTSIDE the cap for the same reason `tool_search` does (model-tiers.ts
 * withDiscovery): a capability limit may decide how MUCH a model can do, and
 * must never silently void a guarantee the product already made.
 */

/** name → tools that must ship whenever it does. */
export const TOOL_COMPANIONS: Readonly<Record<string, readonly string[]>> = {
  // delete_file's own result text offers the undo. Shipping the offer without
  // the tool is a promise the harness cannot keep.
  delete_file: ["restore_file"],
};

/** Every companion required by `names`, excluding names already present.
 *  Not transitive by design: a companion needing its own companion is a chain
 *  nobody has, and quietly resolving one would hide it. */
export function companionsFor(names: Iterable<string>): string[] {
  const have = new Set(names);
  const out: string[] = [];
  for (const name of have) {
    for (const companion of TOOL_COMPANIONS[name] ?? []) {
      if (!have.has(companion) && !out.includes(companion)) out.push(companion);
    }
  }
  return out;
}
