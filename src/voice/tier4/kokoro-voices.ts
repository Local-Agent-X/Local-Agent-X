// Canonical list of Kokoro-82M voice IDs.
//
// kokoro-js ships ~54 voice files in node_modules/kokoro-js/voices/*.bin --
// one per language/gender/persona. Without a guard, settings.json or
// LAX_VOICE_TIER4_VOICE accepts any non-empty string and we only learn it
// was wrong at synth time, after the user has already spoken. This module
// pre-validates so an invalid voice fails fast.
//
// Source of truth: kokoro-js >=1.2.0 voices/ directory.

export const KOKORO_VOICES: ReadonlySet<string> = new Set<string>([
  'af_alloy','af_aoede','af_bella','af_heart','af_jessica','af_kore',
  'af_nicole','af_nova','af_river','af_sarah','af_sky',
  'am_adam','am_echo','am_eric','am_fenrir','am_liam','am_michael',
  'am_onyx','am_puck','am_santa',
  'bf_alice','bf_emma','bf_isabella','bf_lily',
  'bm_daniel','bm_fable','bm_george','bm_lewis',
  'ef_dora','em_alex','em_santa','ff_siwis',
  'hf_alpha','hf_beta','hm_omega','hm_psi',
  'if_sara','im_nicola',
  'jf_alpha','jf_gongitsune','jf_nezumi','jf_tebukuro','jm_kumo',
  'pf_dora','pm_alex','pm_santa',
  'zf_xiaobei','zf_xiaoni','zf_xiaoxiao','zf_xiaoyi',
  'zm_yunjian','zm_yunxi','zm_yunxia','zm_yunyang',
]);

export function isValidKokoroVoice(v: string | undefined | null): boolean {
  return typeof v === 'string' && KOKORO_VOICES.has(v);
}

// Voice ID convention: <lang_letter><gender_letter>_<name>
// e.g. am_michael = a (en-US) + m (male) + michael; bf_emma = b (en-GB) + f (female) + emma.
const LANG_BY_LETTER: Record<string, string> = {
  a: 'en-US', b: 'en-GB', e: 'es', f: 'fr',
  h: 'hi', i: 'it', j: 'ja', p: 'pt-BR', z: 'zh-CN',
};

export interface KokoroVoiceMeta {
  id: string;
  language: string;
  gender: 'female' | 'male' | 'unknown';
  name: string;
}

export function kokoroVoiceMeta(id: string): KokoroVoiceMeta {
  const underscore = id.indexOf('_');
  const prefix = underscore >= 0 ? id.slice(0, underscore) : id;
  const name = underscore >= 0 ? id.slice(underscore + 1) : '';
  const language = LANG_BY_LETTER[prefix[0]] || 'other';
  const g = prefix[1];
  const gender: KokoroVoiceMeta['gender'] = g === 'f' ? 'female' : g === 'm' ? 'male' : 'unknown';
  return { id, language, gender, name };
}

export function kokoroVoiceList(): KokoroVoiceMeta[] {
  return [...KOKORO_VOICES].map(kokoroVoiceMeta);
}
