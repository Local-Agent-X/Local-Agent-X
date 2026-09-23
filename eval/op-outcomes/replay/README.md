# Replaying a kept run against the local runtime

A failed (or `--keep`) op-outcomes case leaves its isolated store under the temp dir
(`lax-eval-*/data/operations`), with every round's request and response in
`op-turns/<i>.trace.json.gz`. These scripts turn that into cache evidence.

- `round-diff.mjs <opsDir>` — per round: prompt/cached tokens and where the request first
  differs from the previous round (system, tools, then messages).
- `replay.mjs <opsDir> <op> <round> [...] [--drop-last] [--last-digest-only]
  [--last-recall-only] [--prefix-from=o,r]` — sends the traced requests to Ollama with
  `max_tokens: 1` and prints `cached_tokens`. Change one thing per pair; each probe ≈12 s.
- `replay-unfold.mjs <opsDir> <op> <r0> <r1>` — the no-fold shape: split the volatile text
  out of r0's last row, then extend with r1's new rows.

Why replay instead of reading diffs: on 2026-09-22 the JSON diff showed a LONGER shared
prefix in the broken case; only the replay showed that a mid-row edit drops the whole
cache while a strict row-extension reuses everything (HARNESS_LOG.md EXP-12c).
