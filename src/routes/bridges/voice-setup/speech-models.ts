// Local speech-to-text models (Whisper sizes, Parakeet): their download
// state for /api/voices/setup/status, and the route that starts a download.
import type { RouteHandler } from "../../../server-context.js";
import { jsonResponse, safeParseBody } from "../../../server-utils.js";
import { createLogger } from "../../../logger.js";
import {
  VALID_WHISPER_VARIANTS,
  ensureWhisperModelDownloaded,
  whisperDownloadState,
  whisperModelExists,
  type WhisperDownloadState,
  type WhisperVariant,
} from "../../../voice/whisper-model-fetch.js";
import { isLocalOnlyMode, LOCAL_ONLY_BLOCK_MESSAGE } from "../../../local-only-policy.js";

const logger = createLogger("routes.bridges.voice-setup");

/** Every local speech model: on disk, downloading (how far), or failed. */
export function sttModelStates(): Record<string, WhisperDownloadState> {
  return Object.fromEntries([...VALID_WHISPER_VARIANTS].map(v => [v, whisperDownloadState(v)]));
}

// Start downloading a local speech-to-text model (Parakeet is ~670 MB) so
// the first voice session doesn't sit silent while it arrives. Returns at
// once; progress is in /status `sttModels`. A voice session that starts
// mid-download joins it rather than starting a second one.
export const handleSpeechModelRoutes: RouteHandler = async (method, url, req, res) => {
  if (method !== "POST" || url.pathname !== "/api/voices/setup/model-download") return false;
  const json = (status: number, data: unknown) => jsonResponse(res, status, data, req);
  const body = await safeParseBody(req); if (body === null) { json(400, { error: "Invalid JSON" }); return true; }
  const model = String((body as { model?: string }).model || "") as WhisperVariant;
  if (!VALID_WHISPER_VARIANTS.has(model)) { json(400, { error: `Unknown speech model: ${model}` }); return true; }
  if (whisperModelExists({ variant: model })) { json(200, whisperDownloadState(model)); return true; }
  if (isLocalOnlyMode()) { json(409, { error: LOCAL_ONLY_BLOCK_MESSAGE }); return true; }
  ensureWhisperModelDownloaded(undefined, { variant: model }).catch((e: Error) => {
    logger.warn(`[voice-setup] ${model} download failed: ${e.message}`);
  });
  json(202, whisperDownloadState(model));
  return true;
};
