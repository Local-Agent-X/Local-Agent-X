# Session handoff — 2026-04-28

Open issues from the office session, written so any workstation can pick up the thread after a `git pull`.

## How to start the next session

```
npm run dev:nowatch
```

NOT `npm run dev`. The watch mode triggers tsx restart cycling on Windows from spurious filesystem events (no src/ file actually changes, but it restarts every 1–2 minutes anyway). Every restart kills any in-flight chat turn silently. `dev:nowatch` is plain `node --import=tsx src/index.ts` — same transpilation, no watcher, stable for long agent sessions and image debugging.

## Image-send chat hang — partially diagnosed, frontend bug remains

**Backend works.** Direct `curl -X POST /api/chat` with `attachments: [{ name, url: "/uploads/...", isImage: true }]` streams a vision response from GPT-5.4 correctly (auto-invokes `view_image`, describes the image).

**WS layer works.** The diagnostic logs `[ws-chat] recv ... imgs=N` fire correctly for text messages. Path `chat-ws → lifecycle.onChat → fetch /api/chat → drain` all log cleanly.

**Frontend image-send broken.** After paste-and-send in the chat UI, **no `[ws-chat] recv` line appears in the log** — the WS message never leaves the browser. Confirmed in Edge with cache disabled, so it's NOT a stale-JS issue.

What's already shipped (in main):
- `d691740` — paste-image upload-race fix (await upload promise in sendMessage)
- `d297c20` — 8s timeout on the upload await (so a hung upload doesn't block forever)
- `caaa59c` — diagnostic logging on WS chat path

What's still unknown: where in chat.js sendMessage the path silently fails. Hypotheses to verify:
- `if (!text && pendingUploads.length === 0) return;` short-circuits because `pendingUploads` is empty when send fires (paste handler may not be populating it for screenshots)
- The chat WS isn't open at send time and the HTTP fallback also silently fails
- An exception is thrown inside sendMessage that's swallowed somewhere

How to debug:
1. Add `console.log` in chat.js sendMessage at line 282 (entry), before/after the early-return on line 287, before/after the upload-promise race, and right before `chatWs.send`. The browser console will show exactly which line short-circuits.
2. Add a paste-handler log at chat.js:1317 to confirm the paste event fires and `addFilesToUpload` actually pushes to `pendingUploads`.
3. Server-side diagnostic logs `[ws-chat] recv` (chat-ws.ts) and `[ws-chat] onChat` (lifecycle.ts) are still in place. Once the path is stable, **revert them**.

Why this matters: image vision worked ~1 week ago. Multiple commits in the past week touched related code, including `2aed20b` (god-file refactor, 74 new files). Could be any of them.

## Other open bugs

**Loop detector misfires on image-bearing replies.**
Detectors in `src/agent-loop-detectors.ts` ("planning-only", "uncommitted-turn", "evidence-stale") classify a complete answer to an image-context question as the agent stalling, and re-invoke the loop. Result: 5 near-identical assistant responses concatenated in a single user turn (session went 12 → 18 messages on one prompt).
Fix shape: when the user message includes an image attachment, exempt or relax those detectors — the agent is giving advice on what they're seeing, not "expected to act."

**Windows Defender blocks `screen_capture` PowerShell script.**
Tool generates a PS1 at `~/.lax/voice-tmp/capture_<id>.ps1` that uses `Add-Type` for screen capture. AMSI flags it as `ScriptContainedMaliciousContent`. Tool fails silently for the user; bash circuit breaker tripped during this session as a side effect.
Fix shape (multi-user repo principle): rewrite the screen-capture path so it doesn't generate a runtime PS1 — precompiled binary, different API, or a script Defender won't flag. Whitelisting the path is per-machine and not acceptable.

**Voice GPU bridge sidecar at :7008 doesn't auto-start.**
Every voice chat fails with `[gpu-bridge] ws error: connect ECONNREFUSED 127.0.0.1:7008`. Sidecar lifecycle is missing from the repo-level boot path. Same shape as :7010 (Studio/Chatterbox) and the GPT-SoVITS tier — needs repo-level auto-start so any user gets working voice out of the box.

## Multi-user repo principle (reminder)

Open Agent X runs on multiple workstations. Per-machine config patches (`~/.lax/`, `~/.claude/`, env vars) are not fixes — every fix must ship in the repo and work out of the box for every user. When unblocking the current session needs a temporary patch, do both: temporary per-machine + repo-level fix in the same change. Never just the per-machine one.
