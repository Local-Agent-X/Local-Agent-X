# Self-edit isolation: how user-driven LAX edits should coexist with upstream updates

Status: design memo, not yet implemented
Author context: design discussion 2026-05-14, triggered by an agent self-edit that added `src/routes/fastmail-proxy.ts` to make a workspace dashboard work

## The problem

LAX currently lets the agent self-edit anywhere in the repo — `src/`, `packages/`, config, anywhere. This is fine for a single-user local install. It is **catastrophic at scale** for three reasons:

1. **Line-level conflicts.** When you ship an upstream update and a user runs `git pull`, any file both of you touched produces a merge conflict. With N users making M arbitrary self-edits, the probability of a clean pull approaches zero.
2. **Contract drift.** Even with no line-level conflict, a self-edit can break assumptions your update relies on. Example: agent renames a function in the user's copy of `agent-guards.ts`; your update adds a caller that imports the original name; user gets a runtime crash on next start. Silent.
3. **No isolation today.** There is no convention separating "core LAX code" from "code my agent generated." Everything lives in `src/` together.

## The four options

| Approach | Where self-edits land | Update collision risk | Power lost |
|---|---|---|---|
| **Workspace-only** | `workspace/`, `config/`, `data/` — never `src/` | Zero | Big — can't add tools, routes, integrations |
| **Plugin slots** | A sandboxed `extensions/` tree with stable hook API (`extensions/routes/*.ts`, `extensions/tools/*.ts`, etc.) | Zero on core; only the extension API surface is shared | Small — most self-edits the agent wants are new routes / tools, which fit |
| **Patch overlay** | Anywhere in `src/`, but stored as a `.patches/` set replayed at boot. Updates apply patches LAST; failures surface loudly | Low — visible patch failures, easy to inspect | Medium — harder to debug |
| **Free-for-all (today)** | Anywhere | Catastrophic at scale | None |

## Recommendation: plugin slots

`extensions/` is the sweet spot. The Fastmail JMAP route the agent just added (`src/routes/fastmail-proxy.ts` + one line in `src/routes/index.ts`) is exactly the shape that fits — a new route file plus one registration call.

If LAX exposed a stable extension API (`registerRoute`, `registerTool`, `registerIntegration`) and required self-edits to land under `extensions/`, the properties are:

- Core stays clean. Upstream updates never conflict with user code.
- Users can inspect their own customizations in one folder.
- Users `git pull` cleanly even after dozens of self-edits.
- If an upstream update changes the extension API contract, old extensions fail loudly at boot — much better than silent drift.

## What "loudly at boot" should mean

When an extension fails to load, the server must:

1. NOT silently disable the broken extension and continue. (Users won't notice their custom feature is gone.)
2. NOT crash the whole server either. (One bad extension shouldn't take LAX offline.)
3. DO surface a top-of-UI banner: "Extension X failed to load against LAX vY.Z. The agent that built it needs to update it." Plus a one-click "ask the agent to fix this" action that hands the load error and the extension API changelog to the agent.

## Migration path from today

A staged rollout that doesn't break existing self-edits:

1. **Phase 1.** Create `extensions/` with a stable loader and the three registration APIs. New self-edits MUST go there (enforce in `self-edit-tool.ts`).
2. **Phase 2.** Move any existing in-tree self-edits into `extensions/` once. Document the move in the upgrade notes. After this, `src/` is core-only.
3. **Phase 3.** Add the extension-API version field. Updates that change it surface the boot banner above.

Phase 1 is the unblock; phases 2-3 can wait.

## Specific to the arikernel situation (2026-05-14)

Separate concern, surfaced during the same discussion: `packages/arikernel/**` files have been intermittently disappearing from disk on this user's home machine for weeks. The self-edit tool currently uses arikernel for sandboxing — if the kernel files are physically gone, the next self-edit either runs without sandboxing (silent loss of safety) or crashes at the import. Either way, a defective state.

Action items (do not block this design doc on these):

- Pin arikernel as a built artifact rather than relying on the source tree being present at runtime, OR add a startup integrity check that refuses to boot the self-edit tool when arikernel files are missing — fail loud, not silent.
- Investigate whether the disappearance is AV-driven (Windows Defender has bitten this repo before — see `Stop AV from quarantining ariKernel` commit `e0efd08`) or whether the self-edit harness itself is wiping the worktree.
