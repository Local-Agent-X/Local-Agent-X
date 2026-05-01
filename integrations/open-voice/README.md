# open-voice integration

This folder is the integration shim between Local Agent X and the standalone
[open-voice](https://github.com/pmajlabs/open-voice) toolkit.

## Why a separate folder

`src/voice/` is the in-tree, batteries-included voice stack — model fetchers,
the WebSocket transport, voice tier UI, the Python sidecar bridge. open-voice
is the *orchestrator core* that's been extracted so it can be reused outside
LAX.

Keeping the bridge in `integrations/open-voice/` means:

- `src/voice/` stays free of `open-voice` imports until the cutover.
- We can build/test the bridge independently behind a feature flag.
- When the bridge is promoted to default, the change in `src/voice/` is a
  one-file shim — not a hundred-file refactor.

## Files

| File | Purpose |
|---|---|
| `bridge.ts` | Wraps SAX's VAD/STT/TTS/Whisper modules as open-voice adapter factories and returns a session-builder. |

## Wiring it in

1. Install the lib in this repo's root `package.json`:

   ```
   npm install file:../open-voice
   ```

2. In `src/voice/audio-ws.ts`, replace the call into `createVoiceSession`
   from `voice-session.ts` with:

   ```ts
   import { createOpenVoiceBridge, isOpenVoiceBridgeEnabled } from "../../integrations/open-voice/bridge.js";
   import * as Vad from "./vad-stream.js";
   import * as Stt from "./stt-stream.js";
   import * as Tts from "./tts-stream.js";
   import * as Whisper from "./whisper-stream.js";

   const buildSession = isOpenVoiceBridgeEnabled()
     ? createOpenVoiceBridge({ vad: Vad, stt: Stt, tts: Tts, whisper: Whisper, runTurn })
     : legacyVoiceSessionFactory(runTurn);
   ```

3. Set `LAX_VOICE_OPEN=1` to flip on the open-voice path.

4. Bench p50/p95 first-audio TTFT vs the legacy orchestrator. Flip the
   default once parity holds (within 5%).

## Cutover plan

- v0: bridge ships behind flag. Legacy orchestrator stays default.
- v1: flip default to open-voice.
- v2: delete in-tree orchestration logic from `src/voice/voice-session.ts`
  (preroll/utterance/playback-tracker/clause-chunker). Net: ~250 LOC reduction.

See `C:\Users\manri\open-voice\docs\INTEGRATION-LAX.md` for the design
context.
