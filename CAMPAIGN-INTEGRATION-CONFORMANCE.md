# Campaign — Integration Plug-and-Play Conformance

> **Handoff document.** Delete this file when the campaign completes and the findings are
> folded into the normal docs. It exists so the campaign can be resumed on another machine.

## RESUME HERE

**Branch:** `campaign/integration-conformance` (do NOT merge to main until C9 passes)
**Progress:** 3 of 9 chunks green (C1, C2, C3). Next wave is **W3: C4 + C5 in parallel** — their
footprints are disjoint, so they can run together.

### ⚠️ Worktree gotcha — put this in every chunk brief

Workflow worktrees are cut from the **session-start HEAD**, not from current `main`. C3's worktree
was created at `d0bb7247`, which predates C2, so `src/credentials/requirements.ts` did not exist in
it. C3 recovered with `git merge --ff-only main` before starting. **Every future chunk brief must
instruct the agent to fast-forward to `main` first and confirm its dependencies are present**,
otherwise it will silently build against a tree missing the chunk it depends on.

### State of the tree when this was written

- `npm run build` is **RED on `main`, and not because of this campaign** —
  `src/llm-dispatch.ts` is 452 LOC against a 400 ceiling, pushed over by commit `094d3888`
  (`fix(vision-judge): ...`) from a concurrent session. Every other gate passes and `tsc` is
  clean. **This must be resolved before C9's integration gate can pass.** Either that work
  splits the file, or it gets split as a separate concern. Do not fold it into a campaign chunk.
- This branch contains **five commits from a concurrent session** (browser stable-ids,
  browser keystroke routing, three vision-judge fixes). They were interleaved with the campaign
  commits on an unpushed local `main`, so separating them would have meant rewriting someone
  else's in-flight history. They came along deliberately.
- `origin/main` was 11 commits behind local `main` at push time. Nothing here has been merged
  to `main` on the remote.

### To resume

1. Read the chunk table + status below. Everything green is committed and skeptic-verified.
2. Next wave is whatever the status table says is `pending` with satisfied dependencies.
3. Re-read **E4'** and **E4''** before writing any chunk brief — they were learned the hard way.
4. Per-wave engine: one workflow per wave, orchestrator merges worktree branches between waves
   (dependency edges make this mandatory — a later chunk's worktree must branch from a tree that
   already contains the earlier chunk's work).

---

## Goal

Make every builtin integration plug-and-play — declared credentials match what the runtime
actually resolves, capabilities that cannot work are not advertised, and no tool description
routes the model to a vendor-locked path — by converging on the credential-requirement mechanism
that already exists in the plugin system.

## Done-list

1. No tool description routes to a vendor-specific connector. All 5 `steer:*` findings gone. ✅
2. A shared credential-requirement type + availability derivation lives in a neutral module,
   consumed by BOTH plugin-system and integrations. No third shape invented. ✅
3. `IntegrationConfig` declares a credential LIST (not one `secretName`); all 11 builtins
   migrated; saved `integrations.json` from older versions still loads.
4. `getAgentContext()` advertises an integration only when its credentials are actually present,
   and only the endpoints its declared authType can satisfy.
5. Settings install modal renders one field per declared credential and persists all of them.
6. `email` declares its real transport + full credential set; Settings → Email configures email
   end-to-end through the EXISTING `writeEmailJson` seam (no second config store).
7. `google` narrowed to what an api_key can honestly satisfy; the hardcoded YouTube probe
   special-case in the test route becomes unnecessary and is removed.
8. A per-tool availability predicate hides unavailable tools from the schema at the single
   canonical seam, including the deferred-tool manifest.
9. Conformance baseline is empty except entries blocked on a parked product decision.
10. `npm run build` green, full unit suite green, new tests on previously-uncovered surfaces.

## Out of scope (deliberate)

- **Google OAuth2** for Calendar/Drive — resolved 2026-07-25: not doing it. C8 narrows Google to
  api-key-honest scope instead.
- **IMAP feature completeness** (discarded UIDs, the `range "*"` bug that returns one message,
  missing folder/move/flag verbs, threading headers) — real bugs, but feature completeness, not
  conformance. Separate campaign.
- **Live smoke tests** (authenticate + one read per INSTALLED integration) — needs real
  credentials, opt-in, not a build gate.
- MCP / connector credential paths beyond lifting the shared type.
- `src/llm-dispatch.ts` 400-LOC breakage (another session's, see above).

## Engineering decisions (made autonomously, recorded)

| # | Decision | Rationale |
|---|---|---|
| E1 | Converge on the plugin system's `PluginSecretRequirement`, lifted to a neutral module, rather than a new integration-only credential type. | It is the only existing mechanism with a typed array + validation + derived availability gate + tested lifecycle against the same `SecretsStore` primitive. Forking would be a third system. |
| E2 | Extend the shared requirement with `secret?: boolean` (default true). | Email needs both vault values (`SMTP_PASS`) and non-secret config (`SMTP_HOST`). One declaration, two sinks. |
| E3 | Non-secret integration config routes through the EXISTING `writeEmailJson` seam for email, not a new per-integration config store. | `email.json` has exactly one writer today; keep it that way. |
| ~~E4~~ | ~~Per-chunk verification = targeted tests + `tsc`.~~ **WRONG — revised after C2's skeptic refuted it.** | `tsc` structurally cannot see `check:codebase-map`, the 400-LOC ceiling, or `no-require`. C2 shipped a red build claiming green because of this. |
| **E4'** | Per-chunk verification = targeted tests + `tsc` + ALL static gates except `check:integrations`. A chunk that adds a directory must run `npm run docs:map` and commit the map. | Catches the C2 class at the chunk, not at the merge. `check:integrations` is excluded because a chunk that fixes a finding makes its own baseline entry stale by design. |
| **E4''** | Baseline reconciliation is the **orchestrator's job at every merge**, not a final chunk. | The gate fails on a stale entry, so a fix chunk cannot land without its baseline entry going with it — `main` would be red between waves. The orchestrator is serial, so there is no write conflict to avoid. |
| E5 | Availability predicate hooks at `resolveToolsForRequest` (`src/tools/tool-search.ts`), with the same predicate applied to the deferred-tool manifest inputs. | Sole per-request convergence point for all audiences; runs before tier-shrink/RAG so unavailable tools don't consume scarce slots. |

## Chunks

| ID | Title | Seam / footprint | Depends | Risk |
|---|---|---|---|---|
| C1 | Remove model-locked steers | `src/tools/email-read-tools.ts`, `src/tools/email-send-tool.ts`, `src/tools/calendar-tools.ts`, `test/tool-description-portability.test.ts` | — | LOW |
| C2 | Lift shared credential-requirement module | `src/credentials/requirements.ts`, `src/plugin-system/manifest.ts`, `src/plugin-system/secret-requirements.ts` | — | MED |
| C3 | `IntegrationConfig` → credential list | `src/integrations/types.ts`, all 11 `src/integrations/builtins/*.ts`, `src/integrations/registry.ts`, `scripts/check-integration-conformance.mjs` (parser only) | C2 | MED |
| C4 | Endpoint auth-feasibility + `getAgentContext` credential gate | `src/integrations/types.ts`, `src/integrations/registry.ts`, `builtins/google.ts`, `builtins/email.ts` | C3 | MED |
| C5 | Multi-credential install modal + route | `public/js/settings-integrations.js`, `src/routes/bridges/integrations.ts` | C3 | MED |
| C6 | Per-tool availability predicate (LOAD-BEARING) | `src/types.ts`, `src/tools/tool-search.ts`, `src/agent-request/prepare-request/build-system-prompt.ts` | C2 | **HIGH** |
| C7 | Email: real transport + full credential set; Settings drives `email_setup` | `builtins/email.ts`, `src/tools/email-config.ts`, `src/tools/email-compose-tools.ts` | C4, C5 | MED |
| C8 | Narrow google to api-key-honest scope | `builtins/google.ts`, `src/routes/bridges/integrations.ts` | C4, C5 | LOW |
| C9 | INTEGRATION GATE: cross-seam contract test, full build, full suite | new contract test | ALL | MED |

**Waves:** W1 `C1+C2` ✅ · W2 `C3` · W3 `C4+C5` · W4 `C7+C8` · W5 `C6` (gate) · W6 `C9`

**Conflict magnets (serialized on purpose):** `types.ts` C3→C4 · `builtins/google.ts` C4→C8 ·
`builtins/email.ts` C4→C7 · `routes/bridges/integrations.ts` C5→C8 · the baseline JSON
(orchestrator only, per E4'').

## Chunk status

| ID | Status | Notes |
|---|---|---|
| C1 | **GREEN** | Merged `a3b4e1e4`. Skeptic `refuted=false`/high — independently re-derived both regex sets and proved them identical, verified the sweep is non-vacuous structurally rather than trusting the agent's revert experiment, confirmed the 80-char `searchHint` prefix is byte-identical so `tool_search` indexing is unaffected. |
| C2 | **GREEN (after orchestrator fix)** | Merged `d89c7205`. Skeptic **REFUTED** it: adding top-level `src/credentials/` left `docs/codebase-map.md` stale → `npm run build` red at `check:codebase-map`, while the parent commit passed. Real defect, caused by the bad E4 verification standard. Map regenerated in `3251a3e2`. Substance survived: parser lifted byte-for-byte, 35 pre-existing plugin tests still green, mutation-tested. |
| C3 | **GREEN** | Merged. `IntegrationConfig` now declares `credentials: CredentialRequirement[]`; `secretName` survives as a derived view of the primary so the HTTP route and Settings modal (both outside the footprint) behave identically. Skeptic `refuted=false`/high: ran 14 mutations against `registry.ts` (12 killed by the chunk's own tests), wrote its OWN pre-migration fixtures instead of trusting the agent's, and confirmed `getAgentContext()` output is byte-identical for all 11 integrations. The hard constraint held — the gate still reports exactly the three baselined findings, proving the shape changed without the semantics moving. |
| C4 | pending | |
| C5 | pending | |
| C6 | pending | |
| C7 | pending | |
| C8 | pending | |
| C9 | pending | |

## ⚠️ MUST FIX IN C7 — a latent hazard C7 itself makes reachable

`src/integrations/registry.ts:51-52` — on a pre-list `secretName` override, only the PRIMARY
credential is cloned; the non-primary entries are returned as **the same object references** as the
module-level `BUILTIN_INTEGRATIONS` declaration:

```ts
const [primary, ...rest] = current;
return [primary ? { ...primary, name: legacy } : { name: legacy }, ...rest];
```

Unreachable today because every builtin declares exactly one credential, so `rest` is always empty.
**C7 gives email a real multi-credential list, which makes it reachable** — at which point a
per-registry mutation could write through into the shared builtin and leak across registries.
Deep-clone `rest` in C7 and add the regression test.

## Open nits carried forward

- C2 left two padded test assertions in `src/credentials/requirements.test.ts` (they assert
  TypeScript literal construction, not behavior). Not a false green — each sits beside a real
  assertion — but they should be trimmed.
- C2's `isSecretRequirement` has no production consumer yet. C7 should consume it to route
  non-secret config (`SMTP_HOST`) away from the vault. If C7 does not, C9 removes it.
- The runtime steer test sweeps `allTools` only; ten plugin-registered tool families
  (memory, secrets, browser, protocol, cron, agent, project, mcp-admin, handler, arikernel-bridge)
  are outside it. No live escape today — the static gate still covers all 226 tool names.
- **Behavior narrowing from C3, undocumented for users:** once the registry saves
  `~/.lax/integrations.json` in the new shape, hand-editing `secretName` in that file is silently
  ignored (the `credentials` list wins). Pre-existing overrides all survive the upgrade — verified
  across all 11 builtins — so nobody loses wiring, but hand-editing is no longer the mechanism for
  repointing an integration at a different vault entry. C5 should make that repointing possible in
  the UI, or it needs a release note.
- Two vacuous arms in `src/integrations/registry.test.ts`: mutations that truncate the non-primary
  credentials, or drop non-name metadata when renaming the primary, both SURVIVE the suite (no
  builtin declares a `description` today, so both sides are `undefined`). Self-disclosed by the
  agent, not hidden. C7's real multi-credential list is what makes these arms testable.
- `credentialNames()` in the conformance script counts raw `[`/`]` and is not string-aware; an
  unbalanced bracket inside a credential `description` would mis-scope the block. Balanced brackets
  are handled correctly. Robustness nit in a deliberate regex parser.

## Completion ledger (fill at end — honest four buckets)

- **Shipped (green):** C1, C2, C3
- **Parked for you:** *(none open — P1 Google OAuth2 resolved: not doing it)*
- **Failed and abandoned:** *(none)*
- **Descoped:** see Out of scope
