# Release qualification

The release gate answers one question: did this exact source revision pass the
evidence required for publication using the current qualification tooling and
runtime environment?

Run it from the repository root:

```bash
npm run release:gate
```

The gate writes `.release-gate/report.json` by default and exits nonzero when
the report is blocked.

## What the gate proves

The ordered gate list lives in
[`scripts/release-gates.mjs`](../scripts/release-gates.mjs). It checks the
release environment, production dependencies, the build, the full release
suite, the versioned qualification packs, and release attribution.

The qualification catalog in
[`scripts/local-qualification/benchmark-packs.mjs`](../scripts/local-qualification/benchmark-packs.mjs)
currently owns four packs:

- installer
- local-model
- plugins
- channels

The catalog, not this document, is authoritative for scenario files, versions,
assertion manifests, skip policy, commands, and deadlines. The current catalog
declares no allowed skips, and the current qualification gates do not authorize
platform skips.

A benchmark does not pass merely because its test process exits successfully.
Its reporter output must match the catalog, every required scenario must
produce valid evidence, no undeclared skip may remain, and its scorecard verdict
must be `pass`. Missing, malformed, stale, incompatible, or forged evidence
blocks the release.

## Reading the report

The top-level release report has only two outcomes: `passed` or `blocked`. It is
`passed` only when every ordered gate has acceptable evidence; otherwise it is
`blocked`, and execution stops after the first blocking gate.

Each executed result records its gate identity, status, timing, output digest,
and skip count; a resumed result names its authenticated receipt. Qualification
results use the versioned contracts in
[`result-schema.ts`](../scripts/local-qualification/result-schema.ts). Their
aggregated scorecards use a separate set of verdicts:

- `pass`: every required scenario passed.
- `product_failure`: at least one result attributes failure to the product.
- `environment_unavailable`: the environment prevented qualification.
- `incomplete`: evidence is missing or does not establish a complete pass.

Only the scorecard verdict `pass` is accepted for a release qualification pack.
Environment unavailability is evidence, not a product pass.

## Resuming a long gate

Resume is opt-in. Set `LAX_RELEASE_GATE_RESUME_KEY` to the same secret of at
least 32 UTF-8 bytes for the original and resumed runs. Supplying the key on the
original run enables signed state writes after each accepted gate. Then resume
with:

```bash
npm run release:gate -- --resume
```

Authenticated receipts are reusable only when their fingerprint and evidence
still match the source revision, the tooling checkout's current `HEAD`, the
runner, the environment, and the benchmark contract. Stale, forged, or
incompatible state fails closed.

Use `--report` and `--state` to choose evidence paths. Versioned release
automation also uses `--source-root` and `--tooling-revision`; the latter must
match the qualification tooling checkout's current `HEAD`.

## Publication boundary

Three versioned publishers run this gate before their build or publish jobs:

- [source releases](../.github/workflows/release.yml)
- [desktop installer releases](../.github/workflows/installer-release.yml)
- [voice-artifact releases](../.github/workflows/build-voice-artifacts.yml)

Those workflows pin the source and tooling revisions and upload the
machine-readable gate report with the release evidence.

[`installer-rolling.yml`](../.github/workflows/installer-rolling.yml) is the
explicit exception. It is a branch-driven rolling installer path that tracks
`main`, not a versioned publisher, and does not run the versioned release gate.
