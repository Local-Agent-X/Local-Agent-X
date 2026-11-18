/**
 * Media transcription engine — the audio track of any ffmpeg-readable file
 * (mp3, m4a, wav, ogg, mp4, mkv, mov, webm …) turned into timestamped text.
 *
 * The tool definition and its path gate live in vision-tools.ts; this module
 * only ever sees a path the security layer already validated, mirroring the
 * ocr-tool.ts split.
 *
 * On this computer (the default) the work is a hidden background job
 * (transcription-job.ts): a recognizer on the server's own thread froze LAX
 * for 15-20 s per minute of audio, and a 30-minute file outran the tool's
 * time limit every time (2026-11-17). A cloud provider is network-bound, so
 * its windows are walked here, one at a time rather than decoded whole: an
 * hour of 16 kHz mono PCM16 is ~115 MB, and the point of taking a path
 * instead of a buffer is to never hold that.
 */

import { decodeFileSegmentToPcm16 } from "../bridge-voice/audio-codec.js";
import { getSharedTranscriber } from "../bridge-voice/stt-helper.js";
import { isWhisperHallucination, resolveSttProviderName } from "../voice/stt-providers/index.js";
import { isLocalOnlyMode } from "../local-only-policy.js";
import { markLongRepeats, stripTranscriptNoise } from "../voice/transcript-noise.js";
import { probeMedia, isFfmpegAvailable } from "../ffmpeg-run.js";
import { ffmpegBin } from "../ffmpeg-bin.js";
import { ensureWhisperModelDownloaded } from "../voice/whisper-model-fetch.js";
import { ensureVadModelDownloaded } from "../voice/vad-model-fetch.js";
import { transcribeInBackground, whenJobEnds } from "./transcription-job.js";
import { announceTranscription } from "./transcription-notify.js";
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
  /** A local job is still transcribing past endSec in the background. */
  stillRunning?: boolean;
  /** The chat is woken when that job ends (transcription-notify.ts). */
  willNotify?: boolean;
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

/** The model a recording is transcribed with, whatever voice chat uses. Voice
 *  chat wants Parakeet's speed on short, clear utterances from the user's own
 *  mic; a recording is often a compressed call, where Parakeet dropped whole
 *  passages. On a 30-minute Teams interview (2026-11-17): Parakeet 3,388
 *  words; Whisper small.en 4,111 ("Hey, be a beaver", a loop of "yeah" over
 *  a whole exchange); large-v3-turbo 4,441 ("Hey, Peter", the exchange
 *  recovered, names right), in 6 min 17 s on 8 cores. medium.en was no
 *  better and a third the speed. A transcript missing or garbling what was
 *  said is worth less than one that takes longer, so accuracy decides: a
 *  ~1 GB one-time download that runs on any 64-bit CPU, no GPU needed. */
export const FILE_TRANSCRIPTION_MODEL = "large-v3-turbo" as const;

/** How long one call waits on a local job before answering with what is done:
 *  inside the tool's 120 s limit, with room for the probe and the reply. A run
 *  nobody is watching waits this long and calls again until the file is done. */
const LOCAL_WAIT_MS = 90_000;
/** In a chat a person is in, a short recording still comes back in one call;
 *  a longer one is left to the background job, which wakes the chat when it
 *  ends, so the agent is not tied up in its turn for minutes. */
const ATTENDED_WAIT_MS = 20_000;

/** On this computer: a hidden background job (transcription-job.ts), so the
 *  server's thread stays free and a long file outlives any one call. */
async function transcribeLocal(
  path: string, durationSec: number, startSec: number, maxSpan: number, opts: TranscribeOptions,
): Promise<TranscriptResult> {
  const model = await ensureWhisperModelDownloaded(undefined, { variant: FILE_TRANSCRIPTION_MODEL });
  const vad = await ensureVadModelDownloaded();
  const waitMs = opts.waitMs ?? (opts.notifySession ? ATTENDED_WAIT_MS : LOCAL_WAIT_MS);
  const req = { path, model, vadModel: vad.model, ffmpeg: ffmpegBin(), durationSec, startSec, maxSpanSec: maxSpan, waitMs };
  const job = await transcribeInBackground(req);
  if (job.error && job.segments.length === 0) throw new Error(job.error);
  const session = opts.notifySession;
  const willNotify = Boolean(session && !job.complete && job.running
    && whenJobEnds(req, (p) => announceTranscription(session!, `transcribe:${path}`, path, startSec, p)));
  const windows = job.segments
    .map((s) => ({ startSec: s.at ?? s.start, text: markLongRepeats(stripTranscriptNoise(s.text)) }))
    .filter((w) => w.text && !isWhisperHallucination(w.text));
  const endSec = job.coveredTo;
  logger.info(`[transcribe_media] ${path} ${formatClock(startSec)}-${formatClock(endSec)} → ${windows.length} window(s), ${job.complete ? "done" : "still running"}${job.native === false ? " (wasm engine)" : ""}`);
  return {
    windows,
    durationSec,
    startSec,
    endSec,
    hasMore: durationSec > 0 ? endSec < durationSec - 1 : !job.complete,
    stillRunning: !job.complete && job.running,
    willNotify,
  };
}

export interface TranscribeOptions {
  startSec?: number;
  maxSpanSec?: number;
  waitMs?: number;
  /** The chat a person is waiting in: woken when a long job ends. */
  notifySession?: string;
}

export async function transcribeMediaFile(path: string, opts: TranscribeOptions = {}): Promise<TranscriptResult> {
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

  if (!provider || provider === "local-whisper") {
    return transcribeLocal(path, probe.durationSec, startSec, maxSpan, opts);
  }

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
