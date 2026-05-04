# Issue 15 — Deletion gate + manifest execution (placeholder)

**Phase:** Post-v1.3, gated.
**Status:** **BLOCKED** until the full deletion gate is satisfied.
**Blocks:** Nothing (final phase).

---

## Goal

Once the deletion gate is satisfied, execute the [PRD §20 deletion manifest](../../canonical-loop-prd.md#20-deletion-manifest-and-deletion-gate) as ten per-concern PRs in priority order, retiring the legacy fragmented paths and finally removing the feature flag itself.

This issue is intentionally a placeholder. **No deletion work begins until the gate conditions are met.** The manifest items will be expanded into individual issues at gate-passage time.

## Gate (every condition must hold before any deletion PR opens)

1. v1.3 has shipped (IDE lane on canonical-loop).
2. Feature flag default ON for all lanes (`interactive`, `build`, `ide`, `background`).
3. 100% of `op_submit_async` traffic has run through canonical-loop for at least 2 weeks.
4. Zero canonical-loop-attributable production incidents in that window.
5. All 11 v1 acceptance tests green.
6. All 9 adapter conformance tests green for every live adapter (Anthropic, Codex, build_app, IDE).
7. No deployment depends on flag-OFF legacy behavior.

If any condition fails, deletions wait. Per-lane gates apply: a lane can be retired independently if its conditions are met, but no deletion happens before v1.3.

## Manifest (to be expanded into 10 individual issues at gate-passage time)

Per [PRD §20](../../canonical-loop-prd.md#20-deletion-manifest-and-deletion-gate):

1. Legacy `op_submit_async` execution path that bypasses canonical-loop.
2. Per-adapter ad-hoc event/status emission.
3. Per-adapter custom abort/kill code outside `adapter.abort()`.
4. Per-adapter custom running/done/in-memory state tracking.
5. Legacy checkpoint/resume/persistence code outside `op_turns`/`op_messages`.
6. Per-lane bespoke orchestrators that bypass canonical-loop.
7. Legacy cancel/stop/redirect plumbing replaced by signal columns + bus.
8. Duplicate status/event endpoints once canonical `op_status` / `op_events_since` cover all paths.
9. Feature flag and its branching — only after one additional sprint all-canonical with no rollback.
10. Legacy-only DB tables/columns after confirmed unused.

## Hard rules (carried from PRD)

- One deletion PR per manifest item. No mega-PR.
- Each deletion PR re-runs full v1 acceptance + conformance suites.
- Each deletion PR references the manifest item number.
- If deletion reveals a hidden dependency: back out, replace properly, never weaken canonical-loop to make legacy deletion easier.
- Deletion of items on the **Do NOT delete** list is forbidden: `tool-executor.ts`, Anthropic OAuth / Claude CLI internals, memory system, provider routing, voice paths, provider-specific adapter logic.

## Permanent invariant (carried from issue 11)

After the gate is met and each deletion lands, the "no op escapes canonical" invariant test must continue to pass. If a deletion would break it, the deletion is deferred or replaced with a proper migration step.

## Definition of done (this placeholder)

- [ ] Gate conditions confirmed in writing (incident log + traffic logs + test runs).
- [ ] Per-manifest issues created (10 issues).
- [ ] Deletion PRs land in priority order.
- [ ] Permanent invariant tests remain green throughout.
- [ ] Feature flag and its branching deleted last.
- [ ] No untouchable system deleted.
- [ ] Final state: one canonical execution path, no legacy fragmented paths.
