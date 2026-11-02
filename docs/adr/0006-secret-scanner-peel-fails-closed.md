# ADR 0006 — The secret scanner's peel sees every encoded run or says it could not

Status: Accepted — 2026-11-02

Carries out step 4 of [ADR 0004](0004-secret-scanner-two-tiers-not-one-verdict.md):
a written threat model and a scan-cost budget before the shared-budget peel is
touched again, and a rebuild, not a patch.

## Context

The scanner decodes every base64, hex and percent run in an outbound payload,
layer by layer, and runs the credential catalog and the known-value pass over
every decoded view. The taint-overlap check and the canary tripwire read the
same views (`decodedPayloadViews`). Measured on 2026-11-02, before this change,
every one of these documents came back `clean=true` or threw:

| Document | Cost to the attacker | Result |
|---|---|---|
| A wrapped key after 256 filler runs inside one encoded object | about 10 KB | `clean=true` |
| A base64 key after 128 KB of decodable filler | 128 KB | `clean=true` |
| A 7 MB base64 image | — | `RangeError` before any verdict |

The first two were the peel's bounds: a cap of 256 inner runs per view, and one
256 KB decode pool spent in document order. Each was a number of filler bytes
an attacker could prepend. The third was V8's backtrack stack: the run regexes
(`[A-Za-z0-9+/_-]{16,}`, and the percent alternation) keep an entry per
character of a greedy loop.

## Threat model

- **Who writes the payload:** a model that may be prompt-injected and holds a
  secret (read from a file, a page, the vault's plaintext, the user's message).
- **What it controls:** every byte. Encodings and how deep they nest, the
  order of runs, filler of any shape, the payload's size up to what the sink
  accepts.
- **What it wants:** a payload that carries the secret and that the scan
  reports clean, so the egress guard, the known-value block, taint and the
  canaries all let it out.
- **What the scan promises:** for every encoded run, either every decoded view
  under it was inspected, or the run is reported as an **uninspected match**
  (`type: "uninspected-encoded"`) spanning the run. That match flows through
  `.matches` like a found secret, so every one of the ~18 consumers fails
  closed without being edited: redaction removes the run, data-lineage treats
  it as a secret span, the known-value block (`scanKnownSecretValues(...).length
  > 0`) refuses. The attacker can buy, at most, a refusal of its own payload.
- **Out of scope:** encodings the peel does not know (rot13, gzip, a custom
  cipher), and a secret split across separate calls. Those were out of scope
  before; the known-value pass and taint are the controls for them.

## Decision

1. **One peel per scan** (`peelEncodedRuns`, `secret-decode-engine.ts`), read by
   the catalog pass, the known-value pass and `decodedPayloadViews`. They used
   to peel three times with three pools.
2. **Every inner run is taken**, no cap; identical inner runs in one tree are
   decoded once.
3. **The pool scales with the input:** 8 characters of decoded views per input
   character, never below 256 KB (the old pool) or above 16 M characters.
   Every decode shrinks its input (base64 to 3/4, hex to 1/2, percent by two
   characters per escape), and the three text views of a base64 decode total
   1.5x its run, so a pure base64 chain costs at most 6x its length; 8 covers it.
4. **A run the pool cannot cover is reported**, not skipped (above). A run that
   does not decode at all is never reported.
5. **Run finding walks character codes** (`char-runs.ts`), shared with the
   entropy detector, which had the same three regexes. A differential test pins
   them to the regexes they replace.
6. **The entropy pass's overlap check is indexed.** It compared each entropy
   hit against every match so far; on a 5 MB base64 image that was 76,000 hits,
   quadratic, and most of the scan's 6 s.

## Measured

- The repo's 5,510 tracked text files (45 MB): identical verdict on every file
  before and after, none uninspected, 13.3 s before and 13.2 s after.
- 5 MB of random base64: 6.2 s before, 2.1 s after. 14 MB: threw before,
  4.8 s after.
- The three documents above: the key is found in the first two; the third
  returns a verdict.
- A percent run nested 400 layers deep in 40 KB exhausts the pool and is
  reported uninspected; the same shape 3 layers deep is peeled to the key.

## Consequences

`clean=true` now means "inspected and clean" for encoded content, which is what
its readers always assumed. A payload that is mostly deeply-nested encoding,
or more than about 10 MB of base64 (16 M characters of views at 1.5 per input
character), can now be refused where it used to pass unread; the corpus shows
ordinary content does not come near it. The two
tests that pinned the old bounds as accepted misses (`256 fillers: MISSED`, and
the penalty-order prefix test) are replaced by tests that the key is found
behind 256 and 1000 fillers and behind 512 KB of filler.

ADR 0004's steps 2 (audit every egress block) and 3 (split the verdict into a
control tier and an advisory tier) are unchanged by this and still open.
