# op-outcomes battery

The harness eval: real tasks, shaped like everyday LAX work, run end to end
through the agent loop with real tool execution, and graded on evidence. It is
the yardstick for harness changes — a change ships when pass rate holds or
improves and the cost metrics don't regress.

## How a run works

For every case × repeat × provider:

1. **Isolated server** (`isolated.mjs`). A fresh LAX process with its own data
   dir, its own copy of `fixtures/workspace/`, and its own port. Your running
   app, `~/.lax` (sessions, memory, learned protocols) and real workspace are
   never touched. Provider logins are read in place through the `self_edit`
   probe mechanism (`seedProbeProvider`), never copied. The browser runs headless.
2. **Fixture server** (`fixtures/server.mjs`). Local pages with invented facts
   (so answers can't come from training data), a cookie wall, a two-step signup
   form, pricing pages, the "original" site, and a mock deploy API. Every request
   is recorded. Its port is registered as a local service in the isolated
   server's `security.json`.
3. **Sessions and turns** from `cases.json` go through `/api/chat`, including
   multi-turn follow-ups and a second session for cross-session memory.
4. **Evidence checks** (`checks.mjs`): file contents, CSS values, a test command
   passing, test files left unmodified, paths deleted or preserved, requests the
   fixture server received, tools not used, a secret absent from the transcript.
   Reply text is checked only for facts that exist solely on a fixture page.
   `test/op-outcomes-checks.test.ts` proves every check can fail.
5. **Metrics** from the isolated op store: rounds, model and tool time, input and
   output tokens, cache read/write, harness nudges, compacted rounds, errors. A run
   whose ops report a different model than requested fails its `model` check
   (silent provider fallback).

## Run

```bash
npm run build   # the battery boots dist/ and refuses one older than src/
npx tsx eval/op-outcomes/run.mjs --provider muse --repeat 3
npx tsx eval/op-outcomes/run.mjs --provider all --only coding
npx tsx eval/op-outcomes/run.mjs --provider grok --only bugfix-with-followup --keep
```

- `--provider` — a label from `providers.json`, or `all` (default).
- `--only` — a case id or category.
- `--repeat N` — runs per case; model behaviour is non-deterministic, so compare
  pass *rates* across N.
- `--keep` — keep every run's temp folder. Failing runs are always kept and their
  path is printed.
- `--timeout ms` — per-turn timeout (default 15 minutes; a case can set `timeoutMs`).

Results are written to `results/run-<timestamp>.json` (gitignored) with every
reply, check detail and metric, stamped with the git HEAD they ran against.

## Adding a case

Keep the task shape real, but point it at fixtures: add pages to
`fixtures/server.mjs`, files to `fixtures/workspace/`, or a setup step to
`SETUP` in `checks.mjs`. Grade with an evidence check, and add a
fail-then-pass test for any new check type in `test/op-outcomes-checks.test.ts`.
