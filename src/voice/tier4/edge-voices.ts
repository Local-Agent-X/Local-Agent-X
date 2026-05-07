// Curated short list of Microsoft Edge neural voices for validation.
//
// Edge exposes hundreds of voices; we don't pre-validate against the full set
// because the cloud catalog drifts and we don't want a UI lookup for every
// session start. This list captures the ~20 popular en-US/en-GB neural voices
// we expect users to actually pick. Anything not in this list is still passed
// through to msedge-tts verbatim.

export const EDGE_VOICES: ReadonlySet<string> = new Set<string>([
  // en-US female
  "en-US-AriaNeural",
  "en-US-JennyNeural",
  "en-US-MichelleNeural",
  "en-US-AnaNeural",
  "en-US-SaraNeural",
  "en-US-NancyNeural",
  // en-US male
  "en-US-GuyNeural",
  "en-US-ChristopherNeural",
  "en-US-EricNeural",
  "en-US-RogerNeural",
  "en-US-SteffanNeural",
  "en-US-BrianNeural",
  "en-US-DavisNeural",
  "en-US-TonyNeural",
  // en-GB
  "en-GB-LibbyNeural",
  "en-GB-SoniaNeural",
  "en-GB-RyanNeural",
  "en-GB-ThomasNeural",
  // en-AU / en-CA
  "en-AU-NatashaNeural",
  "en-AU-WilliamNeural",
  "en-CA-ClaraNeural",
  "en-CA-LiamNeural",
]);

export const EDGE_DEFAULT_VOICE = "en-US-AriaNeural";

export function isCuratedEdgeVoice(v: string | undefined | null): boolean {
  return typeof v === "string" && EDGE_VOICES.has(v);
}

export function edgeVoiceList(): string[] {
  return [...EDGE_VOICES];
}
