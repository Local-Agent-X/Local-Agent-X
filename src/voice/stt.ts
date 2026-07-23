// Local whisper.cpp transcription. Three entry points:
//   - transcribe: default base.en model, with prompt-injection guard
//   - whisperTranscribe: configurable model + language + translate
//   - multiLanguageTranscribe: detect language, then re-transcribe in it
//
// Adversarial audio can make Whisper output prompt-injection text. The
// detectInjection check on transcribe() withholds anything scoring >=0.7:
// the flagged text itself is never returned (echoing it back to the model
// would defeat the point), but the drop is surfaced as a clearly-marked
// notice string so the user isn't left with silent nothing. Brackets are
// stripped from raw Whisper output above, so a bracketed notice can only
// originate here — real speech cannot spoof it.

import { execFileSync } from "node:child_process";
import { writeFileSync, existsSync, unlinkSync } from "node:fs";
import { join } from "node:path";

import { createLogger } from "../logger.js";
import { detectInjection } from "../sanitize.js";
import { WHISPER_EXE, WHISPER_MODEL, VOICE_DIR, tmpPath } from "./paths.js";

const logger = createLogger("voice");

/**
 * Returned in place of a transcription when the injection gate withholds it.
 * Deliberately bracketed: transcribe() strips [.*?] spans from Whisper output,
 * so this marker can never be produced by (or confused with) actual speech.
 * Must never contain the flagged text.
 */
export const VOICE_INJECTION_NOTICE =
  "[voice input withheld — it looked like a command-injection phrase; please rephrase or type it instead]";

export function transcribe(audioBuffer: Buffer): string {
  const wavPath = tmpPath("wav");

  try {
    writeFileSync(wavPath, audioBuffer);

    const output = execFileSync(WHISPER_EXE, [
      "-m", WHISPER_MODEL,
      "-f", wavPath,
      "-np",    // no progress
      "-nt",    // no timestamps
      "-l", "en",
    ], {
      encoding: "utf-8",
      timeout: 30_000,
    });

    let text = output.trim().replace(/\[.*?\]/g, "").trim();
    const lower = text.toLowerCase();
    if (lower === "thank you." || lower === "thanks for watching." || text.length < 2) {
      return "";
    }

    const injections = detectInjection(text);
    if (injections.length > 0) {
      const maxScore = Math.max(...injections.map((i: { score: number }) => i.score));
      if (maxScore >= 0.7) {
        const labels = injections.map((i: { label: string }) => i.label).join(", ");
        logger.warn(`[voice] Transcription withheld — injection patterns [${labels}] (score=${maxScore.toFixed(2)}): "${text.slice(0, 80)}"`);
        return VOICE_INJECTION_NOTICE;
      }
    }

    return text;
  } finally {
    try { unlinkSync(wavPath); } catch {}
  }
}

export type WhisperModel = "tiny" | "tiny.en" | "base" | "base.en" | "small" | "small.en" | "medium" | "medium.en" | "large";

export function whisperTranscribe(
  audioBuffer: Buffer,
  options: {
    model?: WhisperModel;
    language?: string;
    translate?: boolean;
    threads?: number;
  } = {},
): string {
  const model = options.model ?? "base.en";
  const lang = options.language ?? "en";
  const threads = options.threads ?? 4;

  const modelPath = join(VOICE_DIR, "whisper-bin", "models", `ggml-${model}.bin`);
  const effectiveModel = existsSync(modelPath) ? modelPath : WHISPER_MODEL;

  if (!existsSync(WHISPER_EXE) || !existsSync(effectiveModel)) {
    return "";
  }

  const wavPath = tmpPath("wav");
  try {
    writeFileSync(wavPath, audioBuffer);

    const args = [
      "-m", effectiveModel,
      "-f", wavPath,
      "-np", "-nt",
      "-l", lang,
      "-t", String(threads),
    ];
    if (options.translate) args.push("--translate");

    const output = execFileSync(WHISPER_EXE, args, {
      encoding: "utf-8",
      timeout: 60_000,
    });

    let text = output.trim().replace(/\[.*?\]/g, "").trim();
    const lower = text.toLowerCase();
    if (lower === "thank you." || lower === "thanks for watching." || text.length < 2) {
      return "";
    }
    return text;
  } finally {
    try { unlinkSync(wavPath); } catch {}
  }
}

const LANGUAGE_WHISPER_MODELS: Record<string, string> = {
  en: "base.en", es: "base", fr: "base", de: "base", it: "base",
  pt: "base", ja: "base", ko: "base", zh: "base", ru: "base",
  ar: "base", hi: "base",
};

export function multiLanguageTranscribe(
  audioBuffer: Buffer,
): { text: string; language: string; confidence: number } {
  if (!existsSync(WHISPER_EXE)) {
    return { text: "", language: "unknown", confidence: 0 };
  }

  const multiModelPath = join(VOICE_DIR, "whisper-bin", "models", "ggml-base.bin");
  const detectModel = existsSync(multiModelPath) ? multiModelPath : WHISPER_MODEL;

  const wavPath = tmpPath("wav");
  try {
    writeFileSync(wavPath, audioBuffer);

    const detectOutput = execFileSync(WHISPER_EXE, [
      "-m", detectModel,
      "-f", wavPath,
      "-np", "-nt",
      "--detect-language",
    ], {
      encoding: "utf-8",
      timeout: 30_000,
    });

    let detectedLang = "en";
    let confidence = 0;
    const langMatch = detectOutput.match(/language:\s*(\w+)\s*\(p\s*=\s*([\d.]+)\)/i);
    if (langMatch) {
      detectedLang = langMatch[1].toLowerCase();
      confidence = parseFloat(langMatch[2]);
    }

    const text = whisperTranscribe(audioBuffer, {
      model: (LANGUAGE_WHISPER_MODELS[detectedLang] || "base") as WhisperModel,
      language: detectedLang,
    });

    return { text, language: detectedLang, confidence };
  } finally {
    try { unlinkSync(wavPath); } catch {}
  }
}
