# Canonical-Loop v1 — Issue Board

Source of truth: [docs/canonical-loop-prd.md](../../canonical-loop-prd.md).

All issues use the PRD glossary verbatim. Each issue is a vertical slice — independently grabbable, ends in observable behavior, ships behind the feature flag without breaking legacy paths.

---

## v1.0 — Anthropic Interactive on canonical-loop

| # | Issue | Phase | Blocks |
|---|---|---|---|
| 01 | [Schema additions + feature flag compatibility skeleton](01-schema-and-flag-skeleton.md) | Foundation | All other issues |
| 02 | [Fake adapter + acceptance harness](02-fake-adapter-and-harness.md) | Foundation | 03, 05, 06, 07, 08, 11 |
| 03 | [Minimal canonical-loop happy path through `op_submit_async` (flag ON)](03-happy-path-flag-on.md) | Vertical | 04, 05, 06, 07, 08 |
| 04 | [Event log + `op_events_since` reconnect replay](04-event-log-and-reconnect-replay.md) | Vertical | 11 |
| 05 | [Pause + resume at turn boundary](05-pause-and-resume.md) | Vertical | 11 |
| 06 | [Redirect latest-wins at turn boundary](06-redirect-latest-wins.md) | Vertical | 11 |
| 07 | [Cancel mid-stream via `adapter.abort()`](07-cancel-mid-stream.md) | Vertical | 09, 11 |
| 08 | [Lease heartbeat + crash recovery](08-lease-and-crash-recovery.md) | Vertical | 11 |
| 09 | [Anthropic adapter — full conformance + smoke](09-anthropic-adapter-conformance.md) | Vertical | 11 |
| 10 | [Old-path compatibility fixtures (flag OFF)](10-old-path-compat-fixtures.md) | Vertical | 11 |
| 11 | [v1.0 hardening, concurrency isolation, permanent invariants](11-v1-hardening-and-invariants.md) | Cap | Ship gate |

## Post-v1.0 (blocked until v1.0 ships)

| # | Issue | Status |
|---|---|---|
| 12 | [Codex adapter (v1.1) — boundary proof](12-codex-v1-1.md) | Blocked by v1.0 |
| 13 | [`build` lane + build_app adapter (v1.2)](13-build-v1-2.md) | Blocked by v1.1 |
| 14 | [`ide` lane + session-pinned scheduling (v1.3)](14-ide-v1-3.md) | Blocked by v1.2 |
| 15 | [Deletion gate + manifest execution](15-deletion-gate-placeholder.md) | Blocked by v1.3 + 2-week bake |
| 16 | [Pre-stream cancel adapter hang](16-pre-stream-cancel-adapter-hang.md) | Open follow-up (mid-stream cancel works) |

---

## Conventions

- **Glossary:** every term used in issues comes from [PRD §5](../../canonical-loop-prd.md#5-ubiquitous-language--glossary). `adapter_report` (not `adapter_signal`). `canonical-loop` (system) vs `turn_loop` (inner driver).
- **Acceptance test references:** numeric IDs (#1–#11) refer to PRD §18 acceptance tests. Letter IDs (A–I) refer to the adapter conformance suite.
- **Untouchables:** see PRD §19. No issue may modify `tool-executor.ts`, Anthropic OAuth/CLI internals, memory system, provider routing, voice paths, Codex executor, build_app flow, IDE session flow, Ari/policy, secrets storage, sidebar/UI chrome, or package deps.
- **400 LOC limit:** every new module ≤ 400 LOC. Split into focused submodules if growing.
- **Feature flag:** all v1 work ships behind `lax.canonical_loop.{lane}` defaulting OFF. Old paths remain runnable.
- **Per-op flag immutability:** the flag value at submission is captured on `ops.canonical_flag_value`. Mid-flight reroute is forbidden.
