# Canonical-loop recovery — work-in-progress handoff

Status: active work as of 2026-05-14. Continue from this doc on any machine after `git pull`.

## The situation

LAX has two parallel git histories that share no common ancestor:

- **`main`** (checked out, what we're patching) — the canonical-loop refactor. Every provider/spawn/voice/cron path now routes through `src/canonical-loop`. The refactor unified the architecture but **erased a lot of working behavior** that lived on the diverged path.
- **`origin/master`** — the diverged path. Older, but it has the working stop button, voice-session reuse, memory recall, browser tool error guidance, and other fixes the canonical refactor didn't pick up.

`git merge-base main origin/master` returns nothing (no common ancestor). You can't `git merge` or `git rebase` between them. Use `git diff main origin/master -- <path>` for comparison, `git show origin/master:path/to/file` to read a file as it exists on master.

**Strategy:** keep the canonical refactor (it's the right architecture). Port the lost fixes from `origin/master` into the canonical path file-by-file, smallest first.

## Checkpoint

Before any of today's fixes landed:

```
git tag: pre-canonical-fixes-2026-05-14
```

Rollback any single fix or all of them with `git reset --hard pre-canonical-fixes-2026-05-14`. Tag exists on this machine — push it (`git push --tags`) if you want it on other machines too.

## Triage list (from the original investigation)

| # | Symptom | Conf | Port size | Status |
|---|---|---|---|---|
| 1 | Voice spawns an agent per sentence | HIGH | Big (restore deleted `public/js/chat-voice-*.js`) | NOT STARTED — recommended worktree |
| 2 | Stop button doesn't stop | HIGH | Small | NOT STARTED — next on the list |
| 3 | Tools return raw JSON in chat (Anthropic + Codex) | HIGH | Small | **SHIPPED** — text-extractor wired into both adapters |
| 4 | Codex stops at ~6 turns | HIGH | Same as #3 | **SHIPPED** (downstream of #3) |
| 5 | Memory recall sucks | HIGH | Medium | NOT STARTED — needs careful integration in modular split |
| 6 | Browser tools stop working | MED | Small (with care) | NOT STARTED — investigate before touching, don't undo Thriveventory fix |
| 7 | Primal tool policy filtering | MED | Small | NOT STARTED |
| 8 | Agent event bus `broadcastAll` for spawn completions | MED | Small | NOT STARTED |

## Fixes shipped today (commits on main, ahead of origin/main)

Commits (oldest first), all atop `pre-canonical-fixes-2026-05-14`:

- `94422a4` adapters interrupt in-stream when user types
- `c3fbbfd` browser action layer scopes locators into same-origin iframes
- `d82eb4e` drop auto-snapshot from browser fill (Thriveventory PO slowdown)
- `12c8449` context_status reaches WS chat UI (counter no longer stuck at 0K)
- `31542cf` Fastmail JMAP proxy route (agent self-edit)
- `858d805` self-edit isolation design memo
- `6bb36d2` wire tool-call text-extractor into anthropic + codex adapters

Plus pending (uncommitted as of this doc):
- Codex empty-response retry (`src/canonical-loop/adapters/codex.ts`)
- Nudge `kind` metadata + chat-runner filter (`src/canonical-loop/turn-loop.ts`, `src/canonical-loop/chat-runner.ts`)
- Codex CLI new invocation: `exec` subcommand + new flags (`src/tools/builder-tools.ts`)
- `build_app` live progress events (`src/tools/builder-tools.ts`, `src/tool-executor.ts`)

Commit these before pushing (commands at bottom of doc).

## Active investigation: bug C (rendering lag)

Symptom: server emits stream events, op_messages on disk has full assistant text, but the chat UI bubble doesn't render until the user reloads — OR renders after a multi-minute lag.

Status: instrumented but not yet root-caused. Temporary `[stream-debug]` console.log calls are in place at:
- `public/js/chat-send.js` (wsHandler — logs every event arrival with viewing/bodyConnected state)
- `public/js/chat-render.js` (renderStreamContent — logs rAF queue→flush gap)

What we've confirmed:
- ✅ When events DO arrive, the pipeline renders cleanly (viewing=true, bodyConnected=true, deltas apply fast)
- ⚠ The "frozen for minutes" feeling on codex is mostly the model REASONING silently — no stream events while gpt-5.5 thinks
- ⚠ The "need to reload to see content" worse case has not yet been re-reproduced with logging enabled

To continue the investigation on another machine:
1. Pull latest, hard-refresh the browser
2. Open DevTools → Console, filter `[stream-debug]`
3. Trigger a long codex turn (or whatever was repro'ing the bug)
4. When the bug bites, save the console output

The `[stream-debug]` logging is throwaway code. Rip out after diagnosis with:
```
git grep -n "stream-debug" public/js/
```

## Active investigation: codex silent failures + empty-response retry

The codex/ChatGPT subscription endpoint occasionally returns a stream with zero text and zero tool calls after 1-2 min of "thinking." Empty-response retry shipped in `codex.ts` — fires once on this exact pattern, mirrors the same retry already present in `openai-compat.ts`. Confirmed firing in the logs (look for `rounds:2` with the user's prompt unchanged).

## Other notable findings

- **`build_app` defaults to a CLI matching the chat provider.** On codex → spawns `codex` CLI. On anthropic → spawns `claude` CLI. Every other provider silently falls back to claude CLI today — that's a future architectural cleanup. See chat history for context.
- **Codex CLI got rewritten** (0.130.0). Old `--full-auto` is gone; new invocation uses `codex exec --dangerously-bypass-approvals-and-sandbox --skip-git-repo-check --color never`. Fixed in `src/tools/builder-tools.ts`.
- **arikernel files disappear from this user's home machine periodically** (likely AV — see commit `e0efd08` "Stop AV from quarantining ariKernel"). If boot fails with `Cannot find package '@arikernel/runtime'`, restore with `git checkout HEAD -- packages/arikernel/` then `npm install`. Self-edit sandbox depends on it.
- **The Fastmail dashboard works because of an agent self-edit** (commit `31542cf`) that added `src/routes/fastmail-proxy.ts`. JMAP can't be reached from the browser due to CORS — the proxy route was the right call.
- **Nudge messages were rendering as user bubbles** because `appendNudgeAsUserMessage` writes `role:"user"`. Now tagged `content.kind:"nudge"`; `opMessageRowToChatParam` drops them before they reach session.messages. Old nudges already in any chat's localStorage will disappear on the next hydration.

## How to pick up on the other machine

```bash
# 1. On THIS machine — commit pending work and push
cd "/c/Users/peter/Local Agent X"
git status                           # see uncommitted files
git add <files>                      # see commit suggestions below
git commit -m "<message>"            # see suggestions below
git push --tags                      # include the checkpoint tag
git push                             # push commits

# 2. On the OTHER machine
cd "<path-to-LAX>"
git pull
npm install                          # arikernel deps may need re-linking
# If boot fails on @arikernel/runtime: git checkout HEAD -- packages/arikernel/ && npm install
npm run dev
```

## Commit suggestions for the pending work

Three logical commits before push:

1. **Codex silent-fail retry + nudge tagging**
   - `src/canonical-loop/adapters/codex.ts` (retry block)
   - `src/canonical-loop/turn-loop.ts` (nudge kind tagging)
   - `src/canonical-loop/chat-runner.ts` (drop nudges from UI projection)

2. **Codex CLI 0.130 invocation + build_app live progress**
   - `src/tools/builder-tools.ts` (new flags, streamProgress helper, plumbing through buildWithCodex + buildWithClaude)
   - `src/tool-executor.ts` (add build_app to `_onEvent` allowlist)

3. **Temporary [stream-debug] logging for bug C** — commit AS A TEMP DEBUG AID with a clear plan to revert, OR strip and don't commit. Recommended: don't commit; strip the four lines before push. Quick locate: `git grep -n "stream-debug" public/js/`.

## Memory cross-refs

These auto-memory files describe rules the work above respects:

- `feedback_senior_anthropic_engineer.md` — root-cause fixes, no fallback theater
- `feedback_no_better_way_deflection.md` — "it worked before X" is a regression report, not a redesign invitation
- `feedback_no_quick_fixes.md` — ship the correct long-term fix
- `feedback_no_auto_fallback.md` — surface failures, never transparently retry on a different provider
- `feedback_measure_before_shipping_per_action_changes.md` — measure per-action cost before shipping hot-path helpers
- `feedback_multi_user_repo_fixes.md` — fixes must ship in the repo, not per-machine config patches
