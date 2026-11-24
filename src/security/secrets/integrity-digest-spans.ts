/**
 * Integrity digests, which the entropy pass must not read as keys.
 *
 * A subresource-integrity value (`sha512-<base64>`) is a package's or a
 * script's content hash, published on purpose: every npm, pnpm and bun
 * lockfile holds one per package, and a built page's `<script integrity=…>`
 * holds one per tag. It is random-looking bytes by every measure the entropy
 * pass has, so a deploy of a project with a package-lock.json came back as
 * 1,170 "could be a password or access key" findings (label-check, 2026-11-23).
 *
 * What makes a run a digest is the algorithm name in front AND a body that
 * decodes to exactly that algorithm's digest size, in canonical base64. This is
 * the base64 twin of the hex hash lengths entropy-detector.ts already skips,
 * with the same accepted false negative: a key of exactly a digest's size,
 * written as one, is not guessed at. The known-shape catalog and the
 * known-value pass still read the run, so the user's own stored secrets are
 * found in it as before.
 */

/** `sha<bits>-<standard base64>`, as SRI and lockfiles write it. */
const SRI_DIGEST = /\bsha(1|256|384|512)-([A-Za-z0-9+/]+={0,2})/g;

/** Each algorithm's digest size in bytes. */
const DIGEST_BYTES: Readonly<Record<string, number>> = { "1": 20, "256": 32, "384": 48, "512": 64 };

/** Spans of `text` that hold an integrity digest's body: [start, end). */
export function integrityDigestSpans(text: string): Array<[number, number]> {
  const spans: Array<[number, number]> = [];
  SRI_DIGEST.lastIndex = 0;
  for (const m of text.matchAll(SRI_DIGEST)) {
    const body = m[2];
    const bytes = Buffer.from(body, "base64");
    // Canonical and exactly the digest's size: a longer key behind the same
    // prefix decodes to more bytes and stays a candidate.
    if (bytes.length !== DIGEST_BYTES[m[1]] || bytes.toString("base64") !== body) continue;
    const start = (m.index ?? 0) + m[0].length - body.length;
    spans.push([start, start + body.length]);
  }
  return spans;
}
