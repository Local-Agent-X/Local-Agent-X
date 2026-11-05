// Voice tier catalog. Pure data, no DOM. Renderer + handlers in voice-picker.js.
//
// Each tier maps to a (voiceMode, voiceEngine, voiceTier4Provider, voiceSttProvider)
// tuple, plus any other voice setting the tier pins (Local pins
// voiceWhisperModel). Picking a tier writes them all atomically. The chat-bar
// picker reads `voicePool` to filter which voices are eligible.
//
// `prerequisites`: array of { kind, label } — UI renders inline status + an
// install/start/check button next to the tier card when the prerequisite is
// missing. Kinds:
//   sidecar:<id>      Python sidecar from voice-setup.ts (lite/studio)
//   npm:<package>     Node package the runtime can require (kokoro-js, msedge-tts)
//   secret:<name>     Secret in the encrypted vault (GROQ_API_KEY, OPENAI_API_KEY)
//   model:<key>       Local model file the runtime expects to find. A key that
//                     names a speech-to-text variant (parakeet-v3) gets a
//                     Download button and progress; picking the tier starts it.
//   browser-tts       window.speechSynthesis available (always true in modern browsers)
//
// `voicePool`: which voice prefixes/IDs the chat-bar should expose for this tier:
//   "kokoro"  → all am_*/af_*/bm_*/bf_* (and any other Kokoro languages)
//   "edge"    → en-* Neural names from EDGE_VOICES
//   "browser" → window.speechSynthesis.getVoices() runtime list
//   "clones"  → sv:* + cb:* (only on tiers where the python sidecar dispatches them)

window.LAX_VOICE_CATALOG = {
  EDGE_VOICES: [
    ['en-US female', [
      'en-US-AriaNeural', 'en-US-SamNeural', 'en-US-MichelleNeural',
      'en-US-AnaNeural', 'en-US-SaraNeural', 'en-US-NancyNeural',
    ]],
    ['en-US male', [
      'en-US-GuyNeural', 'en-US-ChristopherNeural', 'en-US-EricNeural',
      'en-US-RogerNeural', 'en-US-SteffanNeural', 'en-US-BrianNeural',
      'en-US-DavisNeural', 'en-US-TonyNeural',
    ]],
    ['en-GB', ['en-GB-LibbyNeural', 'en-GB-SoniaNeural', 'en-GB-RyanNeural', 'en-GB-ThomasNeural']],
    ['en-AU / en-CA', ['en-AU-NatashaNeural', 'en-AU-WilliamNeural', 'en-CA-ClaraNeural', 'en-CA-LiamNeural']],
  ],

  TIERS: [
    {
      id: 'browser',
      label: 'Browser / Native',
      tagline: 'Free · works everywhere · no install',
      // In a real browser this tier uses Web Speech API (Google cloud ASR
      // via the browser's baked-in key). In the desktop app the renderer
      // routes STT to the OS native recognizer instead — SFSpeechRecognizer
      // on macOS, System.Speech on Windows — because Electron-Chromium
      // ships without the Google key. TTS stays on window.speechSynthesis
      // either way (OS voices). Same UX in both contexts, different STT
      // engine under the hood.
      detail: 'In a browser: Google Web Speech + browser SpeechSynthesis. In the desktop app: OS native speech recognition (SFSpeechRecognizer on macOS, System.Speech on Windows) + system voices. Robotic but instant — recommended if you just want voice to work right now.',
      settings: { voiceMode: 'browser', voiceEngine: 'tier4', voiceTier4Provider: 'browser', voiceSttProvider: 'browser' },
      voicePool: ['browser'],
      prerequisites: [{ kind: 'browser-tts', label: 'Browser SpeechSynthesis' }],
    },
    {
      id: 'edge',
      label: 'Edge cloud',
      tagline: '~22 neural voices · Microsoft cloud · no API key',
      detail: 'Edge Read-Aloud TTS (Microsoft cloud, no API key) + local Whisper STT (bundled with the desktop app). Optionally swap STT for cloud Groq/OpenAI/Mistral if you have a key — ~250ms vs ~500ms.',
      // local-whisper as the default — works zero-setup with the bundled
      // tiny.en model. Cloud providers stay opt-in via the dropdown.
      settings: { voiceMode: 'standard', voiceEngine: 'tier4', voiceTier4Provider: 'edge-tts', voiceSttProvider: 'local-whisper' },
      voicePool: ['edge'],
      // STT providers the Edge tier can pair with. Picker renders a dropdown
      // and rewrites the `secret:` prereq to whatever the user selects. The
      // first entry is the default for fresh installs.
      sttProviders: [
        { id: 'local-whisper', label: 'Local Whisper (bundled, no key needed)',  secret: '' },
        { id: 'groq',          label: 'Groq Whisper-large-v3 (free tier)',       secret: 'GROQ_API_KEY' },
        { id: 'openai',        label: 'OpenAI Whisper-1 (~$0.006/min, paid)',    secret: 'OPENAI_API_KEY' },
        { id: 'mistral',       label: 'Mistral Voxtral (cheap, EU-hosted)',      secret: 'MISTRAL_API_KEY' },
      ],
      prerequisites: [
        { kind: 'npm:msedge-tts', label: 'msedge-tts npm package' },
        // Tier-2 secret is dynamic — voice-picker.js synthesizes the right
        // `secret:<KEY>` prereq based on the selected sttProvider above
        // (local-whisper has no secret, so no prereq is added).
      ],
    },
    // The no-GPU local tier: everything in-process on the CPU, no sidecar.
    // An earlier "Kokoro local" tier was dropped for being finicky on the
    // GPU (DirectML ConvTranspose crashes); Kokoro's default is now cpu+q8,
    // and Parakeet replaces the tiny.en Whisper that made it mishear —
    // measured 2026-11-04: 4.0% vs 10.2% words wrong, 1.1 s vs 0.95 s per
    // utterance on CPU (whisper-model-fetch.ts).
    {
      id: 'local',
      label: 'Local (no GPU)',
      tagline: 'Kokoro voices · runs on any PC · nothing leaves this machine',
      detail: 'Everything runs on this PC\'s processor, no GPU or sidecar needed: the Kokoro voices (the same ones Studio uses) and NVIDIA Parakeet speech recognition, which mishears far less than the bundled Whisper. Parakeet is a one-time ~670 MB download (the bundled Whisper listens until it finishes); the Kokoro voices (~90 MB) download on the first reply. Replies start about a second after the agent answers, longer on older laptops. No cloned voices — those need Studio.',
      settings: { voiceMode: 'standard', voiceEngine: 'tier4', voiceTier4Provider: 'kokoro', voiceSttProvider: 'local-whisper', voiceWhisperModel: 'parakeet-v3' },
      voicePool: ['kokoro'],
      prerequisites: [
        { kind: 'model:parakeet-v3', label: 'Parakeet speech recognition (~670 MB)' },
        { kind: 'npm:kokoro-js', label: 'Kokoro voices (~90 MB)' },
      ],
    },
    {
      id: 'studio',
      label: 'Studio local',
      tagline: 'Voice cloning · zero-shot clones · GPU recommended',
      detail: 'Python Lite sidecar with Kokoro + faster-whisper. Routes vx: voices to the VoxCPM sidecar (primary clone engine) and cb: to Chatterbox (backup); if a clone engine is down, the reply falls back down the chain to the built-in Kokoro voice. This is where cloned voices live.',
      settings: { voiceMode: 'standard', voiceEngine: 'python', voiceTier4Provider: '', voiceSttProvider: '' },
      voicePool: ['kokoro', 'clones'],
      prerequisites: [
        { kind: 'sidecar:lite', label: 'Lite sidecar (~3–4 GB venv)' },
        { kind: 'sidecar:studio-vox', label: 'VoxCPM sidecar (primary clone engine)', optional: true },
        { kind: 'sidecar:studio', label: 'Chatterbox sidecar (optional — backup clone engine)', optional: true },
      ],
    },
    // NOTE: "OpenAI Realtime" (voiceMode=realtime) was removed from the picker.
    // It proxies the whole session to OpenAI's speech-to-speech API — cloud
    // pay-per-minute, requires a metered OPENAI_API_KEY, and bypasses LAX's
    // tools/memory/persona, so it's not the main agent. The dispatcher branch
    // and src/voice/realtime/* stay in the codebase; activate it for
    // phone/meeting-bot use cases via LAX_VOICE_MODE=realtime (env) — it's no
    // longer a user-facing voice-chat tier.
  ],

  // Default tier when settings.json has no voice keys at all (fresh user).
  // Local in Electron: it is what the server runs with no voice settings
  // (in-process Kokoro, resolveVoiceSettings), private, no GPU; it listens
  // with the bundled tiny.en until Parakeet, downloaded on the first voice
  // session, is on disk. Browser in a real browser (Web Speech API is
  // instant + free, no network round trip on STT).
  DEFAULT_TIER_ID: (typeof navigator !== "undefined" && /electron/i.test(navigator.userAgent || ""))
    ? 'local'
    : 'browser',
};
