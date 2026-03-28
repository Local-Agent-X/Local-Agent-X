# Agent Eyes for Peter — MVP Implementation Plan

## Goal
Add a **thin-client "eyes" layer** to Open Agent X that streams continuous camera + microphone context to the existing agent loop, with low latency, bounded cost, and explicit privacy controls.

---

## 1) MVP Architecture (Thin-Client First)

### Components
1. **Eyes Client (new, lightweight process)**
   - Captures webcam frames + mic audio continuously.
   - Performs minimal local preprocessing (VAD, frame sampling, compression).
   - Sends chunks/events to Open Agent X over authenticated WebSocket.

2. **Eyes Ingest Gateway (new module in server)**
   - Accepts media events from Eyes Client.
   - Buffers short rolling windows per session.
   - Emits normalized events to existing EventBus + chat pipeline.

3. **Perception Pipeline (new module + reuse existing tools)**
   - Camera path: sampled keyframes -> `captureAndDescribe`-style vision summaries.
   - Audio path: chunk transcription via existing `voice.ts`/STT abstraction.
   - Produces compact "percepts" (not raw media) for agent context.

4. **Context Fusion Layer (new)**
   - Merges recent percepts into a concise state block:
     - who is speaking
     - notable visual changes
     - active environment cues
   - Injects this block into `runAgent` context as a side-channel (bounded tokens).

5. **Policy & Control (reuse + extend)**
   - Explicit session controls: start/pause/stop eyes.
   - Redaction/safety checks before percept injection.
   - Keep raw media ephemeral by default (ring buffer only).

### Why this fits Open Agent X now
- Reuses existing building blocks (`voice.ts`, `camera-tool.ts`, `event-bus.ts`, `chat-ws.ts`, security layers).
- Avoids heavy in-browser logic; keeps client thin.
- Allows stepping from perception-only to fully agentic multimodal behavior incrementally.

---

## 2) Core MVP Features

1. **Continuous Ingestion**
   - Webcam sampled at configurable interval (e.g., 1 frame/sec initially).
   - Mic streamed in small chunks (e.g., 1–2s) with VAD gating.

2. **Live Perception Summaries**
   - Visual: short scene deltas ("person entered", "screen changed", "object moved").
   - Audio: rolling transcript with timestamps + speaker hints.

3. **Context Injection into Agent**
   - Last N seconds/minutes summarized and appended to chat context block.
   - Token budget cap + dedup to avoid context flooding.

4. **Operator Controls**
   - `/api/eyes/start`, `/api/eyes/stop`, `/api/eyes/status`.
   - UI indicator when camera/mic active.

5. **Privacy/Safety Defaults**
   - Opt-in session activation only.
   - No long-term raw media storage in MVP.
   - Redact obvious secrets from transcript/percepts before memory save.

---

## 3) Data Flow (End-to-End)

1. **Eyes Client captures**
   - Camera frame + audio chunk.
2. **Client pre-processes**
   - Compress frame (jpeg), VAD gates silent audio.
3. **WebSocket send**
   - `eyes.frame`, `eyes.audio`, `eyes.heartbeat` messages with sessionId + seq + ts.
4. **Server ingest**
   - Validate auth/session, rate-limit, write to in-memory ring buffer.
5. **Perception workers**
   - Audio -> STT text segments.
   - Frame -> vision summary (sampled; not every frame to model).
6. **Fusion**
   - Merge into rolling `PerceptionState` (latest scene + transcript + confidence).
7. **Agent context hook**
   - At chat turn (or periodic assist), append compact percept summary block.
8. **Optional memory write**
   - Persist only high-signal summaries (not raw media), user-controlled.

---

## 4) Practical Build Sequence (Milestones)

## Milestone 1 — Transport + Session Control (1–2 days)
**Outcome:** Eyes client can connect and stream media events reliably.

- Add `src/eyes-protocol.ts` (message schemas, zod validation).
- Add `src/eyes-ws.ts` (WebSocket endpoint `/ws/eyes?token=...`).
- Add session APIs: start/stop/status in `server.ts`.
- Implement per-session ring buffers and heartbeat timeout.

**Exit criteria**
- Can start eyes session and see frame/audio event counters in status.
- Disconnect/reconnect resumes without server crash.

## Milestone 2 — Perception Adapters (2–3 days)
**Outcome:** Media stream converted to compact text percepts.

- Add `src/eyes-ingest.ts` (buffering + fan-out).
- Add `src/eyes-perception.ts`:
  - audio chunk -> STT segment (reuse `voice.ts` abstraction)
  - frame sample -> vision summary (reuse camera/vision path)
- Add dedup + change detection (skip redundant scene text).

**Exit criteria**
- `eyes/status` shows rolling transcript and scene summary updates.
- CPU/network stable under 10-minute run.

## Milestone 3 — Agent Context Integration (1–2 days)
**Outcome:** Agent can "see/hear" through injected perception block.

- Add `src/eyes-context.ts` to produce bounded context snippet.
- Hook into chat execution path before `runAgent` call.
- Add config knobs in `config.ts`:
  - frame sample rate
  - audio chunk duration
  - context token cap
  - enable/disable memory persistence

**Exit criteria**
- User asks "what’s happening around me?" and agent answers using live percepts.
- Context budget remains bounded and deterministic.

## Milestone 4 — UX + Safety Hardening (1–2 days)
**Outcome:** Safe, operable MVP for daily use.

- Add clear UI active-state indicator + quick mute buttons.
- Add transcript redaction pass before memory save.
- Add tests for malformed media messages, auth failures, and overload behavior.

**Exit criteria**
- Manual kill-switch works instantly.
- No raw media persisted by default.
- Basic threat/failure tests pass.

---

## 5) First Actionable Coding Tasks (Start Here)

1. **Create protocol types**
   - New: `src/eyes-protocol.ts`
   - Define `EyesClientMessage` union:
     - `eyes.start`, `eyes.stop`, `eyes.frame`, `eyes.audio`, `eyes.heartbeat`
   - Define server acks/errors.

2. **Add eyes WebSocket manager**
   - New: `src/eyes-ws.ts`
   - Mirror patterns from `chat-ws.ts` (auth, subscriptions, client map).
   - Keep per-session counters + lastSeen timestamp.

3. **Wire endpoint into server startup**
   - Edit `src/server.ts`
   - Initialize eyes manager with auth token.
   - Expose lightweight REST status endpoints:
     - `GET /api/eyes/status?sessionId=...`
     - `POST /api/eyes/start`
     - `POST /api/eyes/stop`

4. **Implement in-memory ring buffers**
   - New: `src/eyes-ingest.ts`
   - Store latest N frames metadata + latest N audio chunks/transcripts.
   - Add max bounds to prevent unbounded memory growth.

5. **Stub perception and context hook**
   - New: `src/eyes-context.ts`
   - Return initial block like:
     - recent transcript lines
     - latest scene summary
   - Inject into chat prompt path as non-user "environment context".

---

## 6) MVP Non-Goals (to protect schedule)
- No full video archival/search.
- No diarization-perfect speaker identity in v1.
- No autonomous camera control/PTZ.
- No multi-device sync in first cut.

---

## 7) Recommended Defaults for Peter’s First Run
- Frame sampling: **1 fps** (summarize every 3–5 frames).
- Audio chunks: **1.5s** with VAD.
- Perception context cap: **400–700 tokens** max.
- Memory persistence: **off by default**, summaries-only when enabled.

---

## 8) Definition of Done (MVP)
- Peter can toggle Agent Eyes on/off from Open Agent X.
- Agent answers with relevant live audio/visual situational awareness.
- System remains responsive for 30+ minutes without runaway memory/tokens.
- Privacy controls are explicit and default-safe.
