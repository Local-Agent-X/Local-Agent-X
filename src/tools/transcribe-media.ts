/**
 * Media transcription engine — the audio track of any ffmpeg-readable file
 * (mp3, m4a, wav, ogg, mp4, mkv, mov, webm …) turned into timestamped text.
 *
 * The tool definition and its path gate live in vision-tools.ts; this module
 * only ever sees a path the security layer already validated, mirroring the
 * ocr-tool.ts split.
 *
 * Long recordings are walked one window at a time rather than decoded whole:
 * an hour of 16 kHz mono PCM16 is ~115 MB, and the point of taking a path
 * instead of a buffer is to never hold that. Windows are transcribed
 * sequentially because the local provider is a single ONNX session.
 */

import { decodeFileSegmentToPcm16 } from "../bridge-voice/audio-codec.js";
import { getSharedTranscriber } from "../bridge-voice/stt-helper.js";
import { isWhisperHallucination, resolveSttProviderName } from "../voice/stt-providers/index.js";
import { isLocalOnlyMode } from "../local-only-policy.js";
import { stripTranscriptNoise } from "../voice/transcript-noise.js";
import { probeMedia, isFfmpegAvailable } from "../ffmpeg-run.js";
import { createLogger } from "../logger.js";

const logger = createLogger("tools.transcribe-media");

/** Window length. Long enough that mid-sentence cuts are rare, short enough
 *  that one window's PCM is ~2 MB. */
const WINDOW_SEC = 60;

/** Ceiling on how much media one call transcribes. Beyond this the caller is
 *  told to continue from an offset rather than being left waiting minutes. */
export const MAX_SPAN_SEC = 1800;

/** Under a tenth of a second of samples there is nothing to recognize. */
const MIN_SAMPLES = 1600;

export interface TranscriptWindow {
  startSec: number;
  text: string;
}

export interface TranscriptResult {
  windows: TranscriptWindow[];
  /** Full duration of the file, or 0 when the container declares none. */
  durationSec: number;
  /** Where this call started, and the first second it did NOT cover. */
  startSec: number;
  endSec: number;
  /** True when the file continues past endSec. */
  hasMore: boolean;
}

function formatClock(totalSec: number): string {
  const s = Math.max(0, Math.floor(totalSec));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const mm = String(m).padStart(2, "0");
  const ss = String(sec).padStart(2, "0");
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

/** Render windows as timestamped lines. Exported for the tool's result text. */
export function formatTranscript(result: TranscriptResult): string {
  return result.windows.map(w => `[${formatClock(w.startSec)}] ${w.text}`).join("\n");
}

export async function transcribeMediaFile(
  path: string,
  opts: { startSec?: number; maxSpanSec?: number } = {},
): Promise<TranscriptResult> {
  if (!(await isFfmpegAvailable())) {
    throw new Error("ffmpeg is not available — it ships with the app and via ffmpeg-static; set LAX_FFMPEG to override");
  }

  // Strict local-only mode must not have a recording shipped to Groq/OpenAI/
  // Mistral behind the user's back. Refuse loudly rather than silently
  // downgrading to the local model — a quiet provider swap is exactly the
  // fallback this codebase forbids.
  const provider = resolveSttProviderName();
  if (provider && provider !== "local-whisper" && isLocalOnlyMode()) {
    throw new Error(
      `LAX_VOICE_STT_PROVIDER is set to "${provider}", which uploads audio off-box, but strict local-only mode is on. ` +
      `Unset it to transcribe with the local model, or turn local-only mode off.`,
    );
  }

  const probe = await probeMedia(path);
  if (!probe.hasAudio) {
    throw new Error("this file has no audio track");
  }

  const startSec = Math.max(0, opts.startSec ?? 0);
  const maxSpan = Math.min(MAX_SPAN_SEC, Math.max(WINDOW_SEC, opts.maxSpanSec ?? MAX_SPAN_SEC));
  // A container with no declared duration still transcribes: we walk until a
  // window decodes to nothing, which is where the stream actually ended.
  const hardEnd = probe.durationSec > 0
    ? Math.min(probe.durationSec, startSec + maxSpan)
    : startSec + maxSpan;

  const transcriber = await getSharedTranscriber();
  if (!transcriber) throw new Error("no speech-to-text provider is available");

  const windows: TranscriptWindow[] = [];
  let cursor = startSec;
  while (cursor < hardEnd) {
    const span = Math.min(WINDOW_SEC, hardEnd - cursor);
    const pcm = await decodeFileSegmentToPcm16(path, cursor, span);
    if (pcm.length < MIN_SAMPLES) {
      // Past the real end of an undeclared-duration stream, or a silent window.
      if (probe.durationSec === 0) break;
      cursor += span;
      continue;
    }
    const raw = await transcriber.transcribe(pcm);
    const text = stripTranscriptNoise(raw ?? "");
    if (text && !isWhisperHallucination(text)) {
      windows.push({ startSec: cursor, text });
    }
    cursor += span;
  }

  logger.info(`[transcribe_media] ${path} ${formatClock(startSec)}-${formatClock(cursor)} → ${windows.length} window(s)`);

  return {
    windows,
    durationSec: probe.durationSec,
    startSec,
    endSec: cursor,
    hasMore: probe.durationSec > 0 ? cursor < probe.durationSec : false,
  };
}
