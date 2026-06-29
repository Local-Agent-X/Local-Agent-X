# eval/capability-grounding

Live battery for the **false-refusal** failure class — the agent refusing an
action it's actually permitted to do (a read it's allowed to make) by guessing
it lacks permission instead of calling the tool. Run it with:

```
npm run eval:grounding
```

## Why this exists

Observed live (2026-06-29, grok-4.3): with file access set to **Unrestricted**,
the agent refused `read ~/Documents/notes.txt` as "outside the workspace
sandbox" — it never called `read`, so the access check never ran. A chat prompt
can't catch this regression because the model's own caution is the bug; the
refusal masks whether the grounding is present. This battery checks the real
artifacts directly, with no LLM:

| Group | What it asserts |
|-------|-----------------|
| `fix1-doctrine` | The constitutional "attempt permitted actions — don't refuse on assumption" rule is live in `loadSystemPrompt()` (the hot-reloaded source) |
| `fix2-block` | `fileAccessGroundingBlock(mode)` states the active policy for each mode (unrestricted = "ANY file"; workspace = blocked BY POLICY, not a missing tool; common = names the content folders + Settings) |
| `fix2-live` | The read-mode → block composition `build-system-prompt.ts` performs: a written `security.json` mode flows through `loadFileAccessMode()` into the matching block |
| `fix2-wiring` | The block is concatenated into BOTH prompt-assembly branches (sub-agent override + base), so sub-agents are grounded too |

The reactive backstop (refuse-without-attempt → grounding nudge) is covered by
`src/agent-guards/loop-detection.test.ts`, not this battery.

Exit 0 = all passed, exit 1 = a regression. Run before shipping prompt or
file-access changes.
