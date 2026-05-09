// Voice tier catalog. Pure data, no DOM. Renderer + handlers in voice-picker.js.
//
// Each tier maps to a (voiceMode, voiceEngine, voiceTier4Provider, voiceSttProvider)
// tuple. Picking a tier writes all four keys atomically. The chat-bar picker
// reads `voicePool` to filter which voices are eligible.
//
// `prerequisites`: array of { kind, label } — UI renders inline status + an
// install/start/check button next to the tier card when the prerequisite is
// missing. Kinds:
//   sidecar:<id>      Python sidecar from voice-setup.ts (lite/studio/studio-trained)
//   npm:<package>     Node package the runtime can require (kokoro-js, msedge-tts)
//   secret:<name>     Secret in the encrypted vault (GROQ_API_KEY, OPENAI_API_KEY)
//   model:<key>       Local model file the runtime expects to find
//   browser-tts       window.speechSynthesis available (always true in modern browsers)
//
// `voicePool`: which voice prefixes/IDs the chat-bar should expose for this tier:
//   "kokoro"  → all am_*/af_*/bm_*/bf_* (and any other Kokoro languages)
//   "edge"    → en-* Neural names from EDGE_VOICES
//   "realtime"→ alloy/echo/fable/onyx/nova/shimmer
//   "browser" → window.speechSynthesis.getVoices() runtime list
//   "clones"  → sv:* + cb:* (only on tiers where the python sidecar dispatches them)

window.LAX_VOICE_CATALOG = {
  REALTIME_VOICES: [
    ['alloy', 'Alloy (default)'],
    ['echo', 'Echo'],
    ['fable', 'Fable'],
    ['onyx', 'Onyx'],
    ['nova', 'Nova'],
    ['shimmer', 'Shimmer'],
  ],

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
      label: 'Browser',
      tagline: 'Free · works on any device · no install',
      detail: 'Browser SpeechSynthesis + Web Speech API. Robotic but instant — recommended if you just want voice to work right now.',
      settings: { voiceMode: 'browser', voiceEngine: 'tier4', voiceTier4Provider: 'browser', voiceSttProvider: 'browser' },
      voicePool: ['browser'],
      prerequisites: [{ kind: 'browser-tts', label: 'Browser SpeechSynthesis' }],
    },
    {
      id: 'edge',
      label: 'Edge cloud',
      tagline: '~22 neural voices · Microsoft cloud · no API key',
      detail: 'Edge Read-Aloud TTS + cloud Whisper STT. ~250ms STT latency. Needs `npm i msedge-tts mpg123-decoder` for TTS and one of the supported STT providers for transcription.',
      settings: { voiceMode: 'standard', voiceEngine: 'tier4', voiceTier4Provider: 'edge-tts', voiceSttProvider: 'groq' },
      voicePool: ['edge'],
      // STT providers the Edge tier can pair with. Picker renders a dropdown
      // and rewrites the `secret:` prereq to whatever the user selects. The
      // first entry is the default for fresh installs.
      sttProviders: [
        { id: 'groq',    label: 'Groq Whisper-large-v3 (free tier)',         secret: 'GROQ_API_KEY' },
        { id: 'openai',  label: 'OpenAI Whisper-1 (~$0.006/min, paid)',      secret: 'OPENAI_API_KEY' },
        { id: 'mistral', label: 'Mistral Voxtral (cheap, EU-hosted)',        secret: 'MISTRAL_API_KEY' },
      ],
      prerequisites: [
        { kind: 'npm:msedge-tts', label: 'msedge-tts npm package' },
        // Tier-2 secret is dynamic — voice-picker.js synthesizes the right
        // `secret:<KEY>` prereq based on the selected sttProvider above.
      ],
    },
    // NOTE: Tier 3 "Kokoro local" (in-process kokoro-js + Node ONNX) was
    // removed from the picker. Studio Lite (tier 4) ships the same Kokoro
    // voices via a Python sidecar with the more robust faster-whisper STT
    // and proper VAD — and users wanting voice cloning need tier 4 anyway,
    // so the in-process variant was redundant and finicky on GPU
    // (DirectML ConvTranspose crashes, no smart Auto device pick).
    // The kokoro-js / tier4-factory adapter stays in the codebase so
    // env-var driven configs (LAX_VOICE_TIER4_PROVIDER=kokoro) and tests
    // still work; only the user-facing picker entry is gone.
    {
      id: 'studio',
      label: 'Studio local',
      tagline: 'Voice cloning · trained voices · GPU recommended',
      detail: 'Python Lite sidecar with Kokoro + faster-whisper. Routes sv:/cb: voices to the Studio-Trained (SoVITS) and Studio (Chatterbox) sidecars internally. This is where Optimus and other trained voices live.',
      settings: { voiceMode: 'standard', voiceEngine: 'python', voiceTier4Provider: '', voiceSttProvider: '' },
      voicePool: ['kokoro', 'clones'],
      prerequisites: [
        { kind: 'sidecar:lite', label: 'Lite sidecar (~3–4 GB venv)' },
        { kind: 'sidecar:studio-trained', label: 'GPT-SoVITS sidecar (optional — for trained clones like Optimus)', optional: true },
        { kind: 'sidecar:studio', label: 'Chatterbox sidecar (optional — for zero-shot clones)', optional: true },
      ],
    },
    {
      id: 'realtime',
      label: 'OpenAI Realtime',
      tagline: 'Full duplex · lowest latency · ~$0.06/min',
      detail: 'Browser audio is proxied straight to OpenAI Realtime; STT/LLM/TTS all happen there. 6 voices. Pay-per-minute.',
      settings: { voiceMode: 'realtime', voiceEngine: 'tier4', voiceTier4Provider: 'kokoro', voiceSttProvider: 'local-whisper' },
      voicePool: ['realtime'],
      prerequisites: [
        { kind: 'secret:OPENAI_API_KEY', label: 'OPENAI_API_KEY (or OPENAI_REALTIME_KEY)' },
      ],
    },
  ],

  // Default tier when settings.json has no voice keys at all (fresh user).
  // Browser is the only option that works with literally zero setup.
  DEFAULT_TIER_ID: 'browser',
};
