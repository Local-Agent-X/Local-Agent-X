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
      'en-US-AriaNeural', 'en-US-JennyNeural', 'en-US-MichelleNeural',
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
      detail: 'Edge Read-Aloud TTS + Groq Whisper STT. ~250ms STT latency. Needs `npm i msedge-tts mpg123-decoder` for TTS and a Groq API key for STT.',
      settings: { voiceMode: 'standard', voiceEngine: 'tier4', voiceTier4Provider: 'edge-tts', voiceSttProvider: 'groq' },
      voicePool: ['edge'],
      prerequisites: [
        { kind: 'npm:msedge-tts', label: 'msedge-tts npm package' },
        { kind: 'secret:GROQ_API_KEY', label: 'GROQ_API_KEY (for STT)' },
      ],
    },
    {
      id: 'kokoro',
      label: 'Kokoro local',
      tagline: '50+ voices · in-process ONNX · CPU or GPU',
      detail: 'Kokoro TTS + local Whisper STT, all in-process via ONNX. ~1.2s first audio on a 3060. Recommended once you\'ve run npm install.',
      settings: { voiceMode: 'standard', voiceEngine: 'tier4', voiceTier4Provider: 'kokoro', voiceSttProvider: 'local-whisper' },
      voicePool: ['kokoro'],
      prerequisites: [
        { kind: 'npm:kokoro-js', label: 'kokoro-js + onnxruntime-node' },
        { kind: 'model:kokoro', label: 'Kokoro ONNX weights (~80MB, auto-downloads on first use)' },
      ],
    },
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
