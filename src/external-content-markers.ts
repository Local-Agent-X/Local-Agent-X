// The boundary markers wrapExternalContent (sanitize.ts) puts around untrusted
// content, and every form a reader recognizes them in. Eight modules used to
// spell the marker themselves — the memory gate, the harness-text scrubber,
// the threat classifier's stripper, the result screen, the delete gate — so a
// reworded wrapper would have slipped past the gates that exist because of it.
// The writer and every reader import from here; external-content-markers.test.ts
// holds the writer's output to each reader.

export const EXTERNAL_CONTENT_TAG = "EXTERNAL_UNTRUSTED_CONTENT";

export function externalContentOpen(id: string): string {
  return `<<<${EXTERNAL_CONTENT_TAG} id="${id}">>>`;
}

export function externalContentClose(id: string): string {
  return `<<<END_${EXTERNAL_CONTENT_TAG} id="${id}">>>`;
}

/** Every minted opening marker in `text`, with its id and position. A fresh
 *  regex per call: a shared global regex carries `lastIndex`, and one caller's
 *  `exec` would make the next caller's `matchAll` start past the marker. */
export function externalContentOpens(text: string): Array<{ id: string; index: number; length: number }> {
  return [...text.matchAll(/<<<EXTERNAL_UNTRUSTED_CONTENT id="([^"]+)">>>/g)].map((m) => ({ id: m[1], index: m.index, length: m[0].length }));
}

/** Any opening marker, however its id was written or lost. */
export const EXTERNAL_CONTENT_OPEN_ANY_RE = /<<<EXTERNAL_UNTRUSTED_CONTENT[^>]*>>>/gi;

/** Any closing marker. */
export const EXTERNAL_CONTENT_CLOSE_ANY_RE = /<<<END_EXTERNAL_UNTRUSTED_CONTENT[^>]*>>>/gi;

/** Either marker as a model might echo it: a slash or END_ prefix, an id or none. */
export const EXTERNAL_CONTENT_MARKER_RE = /<<<\/?(?:END_)?EXTERNAL_UNTRUSTED_CONTENT(?:\s+id="[^"\n]{0,80}")?>>>/gi;

/** A whole wrapped block, markers included. */
export const EXTERNAL_CONTENT_BLOCK_RE = /<<<EXTERNAL_UNTRUSTED_CONTENT id="[^"]*">>>[\s\S]*?<<<END_EXTERNAL_UNTRUSTED_CONTENT id="[^"]*">>>/g;

/** A block whose closing marker was cut off: from its opening to the end. */
export const EXTERNAL_CONTENT_UNTERMINATED_RE = /<<<EXTERNAL_UNTRUSTED_CONTENT id="[^"]*">>>[\s\S]*$/;

/** The tag itself, anywhere: content that passed through the wrapper. */
export const EXTERNAL_CONTENT_TAG_RE = /<<<EXTERNAL_UNTRUSTED_CONTENT/i;

/** Evidence a row came from the wrapper: its tag or the warning it writes. */
export const EXTERNAL_CONTENT_EVIDENCE_RE = /EXTERNAL_UNTRUSTED_CONTENT|INJECTION WARNING/i;
