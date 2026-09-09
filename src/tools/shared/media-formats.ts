/**
 * Container/extension tables for the media tools. Shared so the send path
 * (media-send-tools.ts) and the perception path (vision-tools.ts) agree on
 * what counts as a video, and a format added for one is not missing from the
 * other.
 *
 * These are EXTENSION checks — a fast reject for obvious mismatches, never a
 * content gate. Bytes are authoritative: image sinks sniff with detectMime
 * (image-binary-meta.ts), and the ffmpeg-backed tools let ffmpeg reject what
 * it cannot decode.
 */

export const IMAGE_EXTS = new Set(["png", "jpg", "jpeg", "gif", "webp", "bmp"]);

export const IMAGE_MIME: Record<string, string> = {
  png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg",
  gif: "image/gif", webp: "image/webp", bmp: "image/bmp",
};

export const VIDEO_EXTS = new Set(["mp4", "mov", "webm", "mkv", "avi", "m4v"]);

export const VIDEO_MIME: Record<string, string> = {
  mp4: "video/mp4", m4v: "video/mp4", mov: "video/quicktime",
  webm: "video/webm", mkv: "video/x-matroska", avi: "video/x-msvideo",
};

export const AUDIO_EXTS = new Set(["mp3", "m4a", "wav", "ogg", "oga", "opus", "flac", "aac", "wma", "aiff", "amr"]);

/** Everything transcribe_media will attempt — a video's audio track counts. */
export const TRANSCRIBABLE_EXTS = new Set([...AUDIO_EXTS, ...VIDEO_EXTS]);
