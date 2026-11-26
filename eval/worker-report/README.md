# eval/worker-report

Asks a real model to end a chunk with `chunk_report`, and scores whether each
thing landed in the field the build engine reads it from.

```
npm run eval:worker-report -- [--model <id>] [--only <text>] [--repeat N] [--dry]
```

## Why this exists

The engine acts only on a worker's typed report. A command the machine refused
goes to the owner as an owed check when it is in `machine_blocked`, and costs
fix rounds no worker can win when it is reported as a plain blocked status.
A missing credential is a deferral with how to verify it, never a blocker. So a
model is fit to build only if it fills the report the way the engine reads it.
Run this on a model before trusting it with a build, and after changing the
worker's brief or the tool's descriptions.

## Cases

- `cases.json` holds generic cases written for this repo (public).
- What real builds' workers ran into lives in the private holdout,
  `worker-report/*.json` under `~/.lax-eval-private` (or
  `LAX_EVAL_PRIVATE_DIR`). Never committed: they quote the owner's apps.

A case is the chunk's contract, what happened in the run, and `expect`: the
statuses and done-whens that are right, and for each optional field whether it
must be filled in or must be empty. A field a case leaves out is not scored.

## How it runs

The model gets the worker's own brief (`chunkRoleBrief`) and the tool's own
description and schema, then the case, and answers with the arguments it would
pass. The answer is read by the tool's validator (`readChunkReport`). A refused
answer is handed back once with the tool's message, as in a build.

There is no LAX server and no agent turn. Whether a model ends its run by
calling the tool at all is checked by every build's preflight probe, which
warns when its worker ends without `chunk_report`.

Exit 0 when every report was right. Results are written to the private
folder's `results/`. `--dry` prints the packets and calls no model.

Running it costs one model call per case and repeat (two when the first
answer is refused): run it when asked.
