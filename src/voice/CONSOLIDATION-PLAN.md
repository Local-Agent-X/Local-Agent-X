# Voice Stack Consolidation Plan

> **STATUS (2026-06-06):** Steps 1 & 2 shipped. The two shims are gone
> (`src/voice.ts` was already removed; `src/voice/voice-session.ts` deleted —
> callers import the module directly). The forked per-turn state machine
> (§3.1) is now the single canonical `voice-session/turn-runner.ts`
> (`createVoiceTurnMachine`); both the in-process and GPU factories drive it
> with an injected `TurnSpeaker` + `cancelTts`. Remaining/optional: §3.2
> (realtime scaffolding — dormant), Step 4 (relocate `bridge-voice/`).

**Audit basis commit:** `8d7784c` (HEAD at audit time).
**Scope:** the voice stack only — `src/voice/`, `src/bridge-voice/`, `src/voice.ts`, `python/voice/server.py`. The OpenAI Realtime code is in `src/voice/realtime/` — there is **no** `src/routes/voice-realtime.ts` (request typo; flagged here so the next pass doesn't go hunting for it).

---

## 0. Files in scope (LOC)

Top-level shims:
- `src/voice.ts` — **5 LOC** pure re-export of `./voice/index.js`
- `src/voice/voice-session.ts` — **5 LOC** pure re-export of `./voice-session/index.js`

Voice utilities barrel:
- `src/voice/index.ts` — 16 LOC, exports `synthesize`, `transcribe`, `continuousListen`, EQ presets, TTS-interruption hooks, `detectCapabilities`

Session orchestrator (already split):
- `src/voice/voice-session/index.ts` — 380 LOC, in-process CPU/tier4 factory
- `src/voice/voice-session/settings.ts` — 134
- `src/voice/voice-session/model-init.ts` — 224
- `src/voice/voice-session/audio-buffers.ts` — 99
- `src/voice/voice-session/types.ts` — 32

GPU path:
- `src/voice/gpu-session.ts` — 298 LOC, full per-session orchestrator over the Python sidecar
- `src/voice/gpu-bridge.ts` — 193 LOC, WS client to the sidecar

Realtime (OpenAI) path:
- `src/voice/realtime/{index,realtime-session,openai-realtime-client,resampler}.ts`

Transport:
- `src/voice/audio-ws.ts` — 194 LOC, `/ws/voice` server + the `VoiceSession` / `VoiceSessionContext` contract

Python sidecar:
- `python/voice/server.py` — 742 LOC, self-contained streaming voice service (VAD + faster-whisper + Kokoro on GPU)

Bridge-side voice (Telegram/WhatsApp):
- `src/bridge-voice/{index,audio-codec,stt-helper,voice-prefs,chunk-text}.ts`

---

## 1. Single public entry point — recommendation

**Vote: collapse to `src/voice/index.ts` and delete both top-level shims.**

The repo currently has **four** plausible "voice entry points":

| File | Role today | Purpose |
| --- | --- | --- |
| `src/voice.ts` | Shim → `voice/index.js` | Legacy import path for `synthesize`, etc. |
| `src/voice/index.ts` | Real barrel | One-shot utilities (synth / transcribe / EQ) |
| `src/voice/voice-session.ts` | Shim → `voice-session/index.js` | Legacy path for `createVoiceSessionFactory` |
| `src/voice/voice-session/index.ts` | Real factory | Streaming session orchestrator |

The two top-level shims exist for a reason that no longer applies — the underlying directories already exist, the import paths already point at them through the shims, and there is no third caller waiting in the wings. They are pure indirection.

**Proposal:**

- Make `src/voice/index.ts` the single canonical surface, re-exporting both **stateless utilities** (`synthesize`, `transcribe`, `continuousListen`, `applyEQPreset`, `detectCapabilities`, `registerTTSProcess`, `interruptSpeech`, `wasTTSInterrupted`) and the **factory** (`createVoiceSessionFactory`, plus types `VoiceTurnInput`/`VoiceTurnResult`/`VoiceTurnRunner`/`SecretLookup`/`VoiceEngineId`).
- Delete `src/voice.ts` and `src/voice/voice-session.ts`.

This is a one-shot move with zero behavior change. The "two surfaces" concern (stateless utils vs stateful factory) is real but already lives inside the same barrel — what's behind the curtain stays separated by file; the public name `voice/` just stops lying about depth.

Runner-up option (if we want to keep the orchestrator surface explicit): keep `voice/index.ts` for utilities, **rename** `voice/voice-session/` → `voice/session/` and re-export through `voice/session.ts`. Two files instead of one. Less attractive because callers already understand the current import; the cost is in the shims, not the names.

---

## 2. Call graph

### External callers (outside `src/voice/`)

```
src/server/lifecycle.ts
  └─ setupVoiceWebSocket, setVoiceSessionFactory  ← src/voice/audio-ws.ts (line 73)
  └─ createVoiceSessionFactory                    ← src/voice/voice-session.ts (line 74, shim)
  └─ type VoiceTurnRunner                         ← src/voice/voice-session.ts (line 78, shim)

src/telegram-bridge.ts
  └─ synthesize                                   ← src/voice.ts (line 15, shim)
  └─ encodeWavToOgg, isFfmpegAvailable,
     transcribeOggBuffer, getVoicePref,
     splitForVoiceChunks                          ← src/bridge-voice/index.ts (line 13)

src/whatsapp-bridge/voice-reply.ts
  └─ synthesize                                   ← src/voice.ts (line 22, shim)
  └─ encodeWavToOgg, isFfmpegAvailable,
     getVoicePref, splitForVoiceChunks            ← src/bridge-voice/index.ts (line 21)

src/server/bootstrap-bridges.ts
  └─ getVoicePref, setVoicePref                   ← src/bridge-voice/index.ts (line 10)

src/routes/bridges/voice-dictate.ts
  └─ transcribeOggBuffer                          ← src/bridge-voice/stt-helper.ts (line 12)
  └─ isFfmpegAvailable                            ← src/bridge-voice/audio-codec.ts (line 13)
```

### Internal edges (inside `src/voice/`)

```
voice-session/index.ts (in-process orchestrator)
  ├─ audio-ws.ts                       (VoiceSession + Context types)
  ├─ stt-stream.ts, tts-stream.ts,
  │  vad-stream.ts, whisper-stream.ts  (engines)
  ├─ gpu-session.ts                    (when engine === "python")
  ├─ realtime/index.ts                 (when mode === "realtime")
  ├─ tier4/index.ts                    (when engine === "tier4")
  └─ voice-session/{settings,
        audio-buffers, model-init,
        types}                         (internal helpers)

gpu-session.ts
  ├─ audio-ws.ts                       (types)
  ├─ gpu-bridge.ts                     (WS client)
  └─ voice-session.ts (shim)           ← imports VoiceTurnRunner type

gpu-bridge.ts
  └─ ws://127.0.0.1:${LAX_VOICE_PORT or 7008}/voice  → python/voice/server.py

realtime/index.ts
  ├─ realtime/realtime-session.ts
  └─ realtime/openai-realtime-client.ts

bridge-voice/stt-helper.ts (cross-module)
  ├─ voice/stt-providers/index.ts
  ├─ voice/whisper-model-fetch.ts
  └─ voice/whisper-stream.ts
```

### The dispatcher decision (voice-session/index.ts:30-59)

```
createVoiceSessionFactory(runTurn, getSecret) → (ctx) =>
   if voiceSettings.mode === "realtime" && realtimeReadiness().ready
     → createRealtimeSessionFromEnv(ctx, overrides)        (realtime/)
   else if engine === "python"
     → createGpuSession(ctx, runTurn)                      (gpu-session.ts)
   else (engine in {"tier4", "cpu_fallback"})
     → in-process VoiceSession built inline in this file   (380-line closure)
```

Three peer paths; the third one isn't extracted — it's the body of `voice-session/index.ts`. That asymmetry is the heart of the duplication problem.

---

## 3. Duplicates / near-duplicates

### 3.1 Major: the turn state machine is implemented twice

Both `voice-session/index.ts` (CPU/tier4 path) and `gpu-session.ts` (GPU path) carry their own copy of the same per-session machinery. Same shape, same events, same lifecycle, drifting in details.

| Concern | `voice-session/index.ts` | `gpu-session.ts` |
| --- | --- | --- |
| Sentence-terminator regex `[.!?]["')\]]?` | line 28 | line 20 |
| Per-turn `AbortController` (barge-in) | 67, 165-180 | 33, 67-80 |
| `pendingClearTimer` + `PLAYBACK_TAIL_MS=250` + `expectedPlaybackEndMs` | 74-77, 116-125 | 46-48, 92-114 |
| `pendingFrames` queue with 17-frame cap | 79, 316 | 38, 271 |
| `handleFinalTranscript(utterance)` with dictate-mode short-circuit + `agent_start` → `runTurn` → `assistant_done`/`assistant_interrupted` + history merge with `[interrupted by user]` marker | 212-308 | 129-265 |
| Sentence-flush loop calling `tts.speak(sentence)` / `bridge.speak(sentence)` | 236-250 | 187-210 |
| Close path: abort active turn, tear down engines, clear timers, drain pending frames | 362-373 | 289-296 |

The GPU path adds a long-sentence clause splitter (`CLAUSE_BREAK`, `CLAUSE_MIN_CHARS`, `LONG_SENTENCE_CHARS`, `speakSentence` in gpu-session.ts:20-27, 160-186); that's a real tier-specific behavior that should land as a pluggable speak callback, not a forked copy of everything around it.

**Why it matters:** the dictate guard, the playback-tail timer, and the abort handling have already drifted in subtle ways (e.g., `tts_idle`-on-empty-reply logic differs between the two). The next bug fix is going to land in one and miss the other.

### 3.2 Major: three `VoiceSession` implementations

`realtime/realtime-session.ts` is a third complete implementation of `VoiceSession` — not because it shares the state machine (it can't; OpenAI runs it server-side) but because its lifecycle scaffolding (auth gate, pending-frame queue, close path, voice/speed live updates) re-creates patterns already in the other two. Lower-priority than 3.1, but the close/disconnect/error event surfaces should reuse a thin shared helper.

### 3.3 Minor

- **Engine dispatcher is half-inline.** The "in-process" branch is the rest of `voice-session/index.ts`; the python and realtime branches are separate factories. Pulling the in-process body into its own `voice-session/in-process-session.ts` makes the three peers symmetric.
- **Logger names diverged.** voice-session uses `voice.voice-session`; gpu-session uses `voice.gpu-session`; settings/model-init log under `voice.voice-session`. Cosmetic but worth normalizing during the merge.

---

## 4. Merge order

Each step is independently shippable and independently reversible.

### Step 1 — Inline the shims (mechanical, zero behavior change)

- Delete `src/voice.ts`.
- Delete `src/voice/voice-session.ts`.
- Update the 6 import sites (listed in §5).

This is the lowest-risk move and earns the most readability. Do it first so subsequent steps don't have to thread through two indirection layers.

### Step 2 — Extract the shared turn-runner

Create `src/voice/voice-session/turn-runner.ts`. It owns:

- `SENTENCE_TERMINATOR`
- `handleFinalTranscript(utterance, { speakSentence, runTurn, ctx, history, … })` — dictate guard, `agent_start`, abort controller, sentence buffer, `runTurn` invocation, `assistant_done` / `assistant_interrupted`, history merge.
- The playback-end estimator (`pendingClearTimer`, `expectedPlaybackEndMs`, `PLAYBACK_TAIL_MS`, `tts_idle` / `playback_complete` emission).
- The pending-frame queue (17-frame cap).
- The barge-in trigger (abort + cancel + `tts_interrupt`).

Engine-specific bits (which TTS to call, whether to clause-split, where to read sample rate from) become callbacks into this runner. After this step:

- `voice-session/index.ts` (in-process) is ~150 LOC of "build engines + wire callbacks into runner".
- `gpu-session.ts` is ~120 LOC of "build bridge + wire callbacks into runner, with the clause splitter as the `speakSentence` impl".

### Step 3 — Promote the dispatcher

Rename `voice-session/index.ts` → `voice-session/in-process-session.ts`. Create a new `voice-session/index.ts` whose only job is dispatch:

```
realtime?    → realtime/createRealtimeSessionFromEnv
engine=python → gpu-session/createGpuSession
engine=tier4 / cpu_fallback → in-process-session/createInProcessSession
```

Now the three engine paths are peer factories under one dispatcher, each thin. The factory consumed by `setVoiceSessionFactory` is the dispatcher.

### Step 4 — Optional: relocate `bridge-voice/` under `voice/`

`src/bridge-voice/` already reaches into `src/voice/stt-providers/` and `src/voice/whisper-*`. Moving it to `src/voice/bridge/` would put all voice code under one root. Five import sites to update (see §5). Cosmetic — defer unless we're already touching those files.

---

## 5. Risk / callers to update

### Touched by Step 1 (the shim removal)

| File | Line | Change |
| --- | --- | --- |
| `src/telegram-bridge.ts` | 15 | `"./voice.js"` → `"./voice/index.js"` |
| `src/whatsapp-bridge/voice-reply.ts` | 22 | `"../voice.js"` → `"../voice/index.js"` |
| `src/server/lifecycle.ts` | 74 | `"../voice/voice-session.js"` → `"../voice/voice-session/index.js"` (or `"../voice/index.js"` if §1 routes `createVoiceSessionFactory` through the main barrel) |
| `src/server/lifecycle.ts` | 78 | same path in the `import("…").VoiceTurnRunner` type-import |
| `src/voice/gpu-session.ts` | 15 | `"./voice-session.js"` → `"./voice-session/index.js"` (still inside the voice dir) |

There are no other consumers. Confirmed by grepping for `from ["'][^"']*voice(\.js|/index\.js|/voice-session)` — only the five lines above plus the shims themselves match.

### Touched by Step 2 (shared turn-runner)

No external callers. The change is entirely inside `voice-session/index.ts` and `gpu-session.ts`. The `VoiceSession` interface returned to `audio-ws.ts` stays identical (`onMicFrame`, `onEndOfSpeech?`, `onVoiceSettings?`, `onTranscript?`, `close`).

### Touched by Step 3 (dispatcher promotion)

If `voice-session/index.ts` is renamed to `voice-session/in-process-session.ts`, the path change is **internal** because every external import goes through `createVoiceSessionFactory` re-exported from the new `voice-session/index.ts`. Net external delta: zero.

### Touched by Step 4 (bridge-voice → voice/bridge — optional)

| File | Line | Change |
| --- | --- | --- |
| `src/server/bootstrap-bridges.ts` | 10 | `"../bridge-voice/index.js"` → `"../voice/bridge/index.js"` |
| `src/routes/bridges/voice-dictate.ts` | 12 | `"../../bridge-voice/stt-helper.js"` → `"../../voice/bridge/stt-helper.js"` |
| `src/routes/bridges/voice-dictate.ts` | 13 | `"../../bridge-voice/audio-codec.js"` → `"../../voice/bridge/audio-codec.js"` |
| `src/telegram-bridge.ts` | 13 | `"./bridge-voice/index.js"` → `"./voice/bridge/index.js"` |
| `src/whatsapp-bridge/voice-reply.ts` | 21 | `"../bridge-voice/index.js"` → `"../voice/bridge/index.js"` |

Plus the three internal imports in `bridge-voice/stt-helper.ts:19,23,24` (which become `../stt-providers/index.js` etc., shorter, since we'd be one level closer).

### Out of scope

- `python/voice/server.py` — self-contained network service. Touched only via the WebSocket protocol described in its docstring; consolidation in TypeScript-land doesn't reach it.
- `src/voice/realtime/*` — already a clean sub-package; only the dispatcher edge changes in step 3.
- `src/voice/{tier4,stt-providers,whisper-*,stt-*,tts-*,vad-*,gpu-bridge}.ts` — these are engines / fetchers; they're not part of the entry-point ambiguity and shouldn't be touched by this consolidation.

---

## 6. Open questions for the next pass

1. **Voice-session entry vs voice-utilities entry — one or two public files?** Plan above votes one (`voice/index.ts`). If we want a clean separation between "stateless utils" and "factory", split into `voice/utils.ts` + `voice/session.ts` and let the top-level `voice/index.ts` re-export both. Pick before step 1 because step 1 wires the new path everywhere.
2. **Does `bridge-voice` actually want to be inside `voice/`?** Step 4 is optional. The argument for keeping it separate is that bridge-side voice (one-shot OGG ↔ PCM for messaging) is a distinct lifecycle from the streaming WS session and pulling it under `voice/` blurs that line. Skip step 4 unless we want a one-folder voice surface.
3. **`gpu-session.ts` clause splitter — does it belong on every tier, or only on Python sidecar?** When step 2 lifts the turn-runner, decide whether `speakSentence` clause-splitting is a tier-4 / cpu-fallback feature too. The clause-split saves time-to-first-audio on slow synth pipelines; cpu-fallback could plausibly want it. Tier 4 with its ~1.2s first-audio probably doesn't.

---

**Audit basis commit:** `8d7784c99a98ffbf3f36d1901626cbfebbfb0653`
