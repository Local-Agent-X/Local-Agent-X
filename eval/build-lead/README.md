# eval/build-lead

Replays decisions a build lead was asked, against a real model, and scores each
answer as right, wrong or neutral by the case's own labels.

```
npm run eval:build-lead -- [--model <id>] [--only <text>] [--repeat N]
```

## Why this exists

The build engine's decision rules were changed after each live failure and
judged by the next live build. A fix for one chunk could undo the fix for
another without anyone seeing it until a build stopped again. This runs every
recorded decision through the current lead role and packet, so a change is
measured against all of them at once.

## Cases

- `cases.json` holds generic cases written for this repo (public).
- Real builds' decisions live in the private holdout, `build-lead/*.json` under
  `~/.lax-eval-private` (or `LAX_EVAL_PRIVATE_DIR`). They are never committed:
  they quote the owner's apps.

A case is a `LeadSituation` (`src/auto-build/advisor/lead-decisions.ts`), the
answers that are `right`, the answers that are `wrong`, and `why`.

## How it runs

Each case is rendered with `leadPacket` (the same text a lead gets) and sent
through `classifySchema` on the provider LAX is set to. The answer is read with
`readDecision`, as `build_decide` reads it. There is no LAX server and the lead
has no tools, so a case is judged on its packet alone.

Exit 0 when no answer was wrong or missing. Results are written to the private
folder's `results/`.

Running it costs one model call per case and repeat: run it when asked.
