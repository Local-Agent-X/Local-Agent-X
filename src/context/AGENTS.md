# context

**Owns:** System-prompt assembly — ordered static-then-dynamic sections (`SystemPromptBuilder`), the product agent's rules section (`config/agent-rules.md`), the runtime section, the rule registry that proves a behavioural rule is still delivered, and budget-driven section shedding.
**Does not own:** Token-budget history compaction → `src/context-manager/`; the per-turn pipeline that calls the builder → `src/agent-request/prepare-request/`; the prompt text itself → `config/system-prompt.md`.
**Entry:** no index. Public files: `system-prompt-builder.ts` (`createSystemPromptBuilder`, `asRecalledData`, `PromptPriority`), `agents-md-section.ts`, `rule-registry.ts`, `prompt-degradation.ts`, `runtime-section.ts`, `prompt-mode.ts` (which base-prompt parts a chat or a code session carries), `agents-md-files.ts` (the one reader of a repo's AGENTS.md files), `project-agents-md.ts` (a code session's project rules).

## Invariants
- Static sections are emitted before dynamic ones so providers with prompt caching keep a stable prefix; anything that changes per turn belongs in the dynamic group.
- Shed order is by class: `tuning` → `navigation` → `facts`; `safety` and `identity` are never shed. A rule whose only home is a sheddable section is silently lost on small local windows — give it a second channel and register it in `rule-registry.ts`.
- `agents-md-section.ts` injects `config/agent-rules.md`, not the repo-root `AGENTS.md` (that file is for coding agents; its lanes contradict the `setting` rule). A code session's prompt carries its own project's AGENTS.md instead (`project-agents-md.ts`), framed as that project's conventions.
- A code session drops base-prompt parts (`prompt-mode.ts`); every behavioural rule must still reach it, which `rule-coverage.test.ts` checks with its code-session profiles.
- Recalled memory enters only through `asRecalledData` fences; never concatenate recall as plain prompt text.

## Coupled to
| If you change | Also check | Guard |
|---|---|---|
| `config/system-prompt.md` `## ` headings | `prompt-degradation.ts` ids, `rule-registry.ts` channels | `rule-coverage.test.ts`, `prompt-degradation.test.ts` |
| `rule-registry.ts` | `src/routes/chat/system-prompt-augmentations.ts`, `src/canonical-loop/public/nudge-ids.ts` | `rule-registry.test.ts`, `rule-coverage.test.ts` |
| `system-prompt-builder.ts` section order | `src/agent-request/prepare-request/build-system-prompt.ts`, `session-prompt-snapshot.ts` | `system-prompt-builder.test.ts`, `system-prompt-builder.session-snapshot.test.ts` |
| `PROMPT_WINDOW_SHARE` (`src/context-manager/request-fit.ts`) | `prompt-degradation.ts` budget | `prompt-degradation.test.ts` |

## Tests
`npx vitest run src/context` (PowerShell on Windows)
