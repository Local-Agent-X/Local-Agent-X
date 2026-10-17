/**
 * The boundary ids wrapExternalContent (sanitize.ts) minted in this process,
 * and the reader that finds those blocks' bodies again. A block counts as the
 * wrapper's own only when its id is here: a file or a command's output can
 * carry the marker text, and a forged frame must not hide what sits outside it
 * from the result screen.
 */

import { externalContentClose, externalContentOpens } from "./external-content-markers.js";

const MINTED_BOUNDARIES = new Set<string>();
const MINTED_BOUNDARY_CAP = 10_000;

export function rememberMintedBoundary(id: string): void {
  MINTED_BOUNDARIES.add(id);
  if (MINTED_BOUNDARIES.size > MINTED_BOUNDARY_CAP) {
    MINTED_BOUNDARIES.delete(MINTED_BOUNDARIES.values().next().value as string);
  }
}

/** The <content> bodies of the minted blocks in `text`, or null when it
 *  carries none. A block cut short by truncation runs to the closing marker
 *  closeUnterminatedExternalBlocks put back. */
export function mintedBlockBodies(text: string): string[] | null {
  const bodies: string[] = [];
  for (const { id, index, length } of externalContentOpens(text)) {
    if (!MINTED_BOUNDARIES.has(id)) continue;
    const start = index + length;
    const end = text.indexOf(externalContentClose(id), start);
    const block = text.slice(start, end === -1 ? undefined : end);
    const open = block.indexOf("<content>\n");
    if (open === -1) continue;
    const close = block.lastIndexOf("\n</content>");
    bodies.push(block.slice(open + "<content>\n".length, close > open ? close : undefined));
  }
  return bodies.length > 0 ? bodies : null;
}
