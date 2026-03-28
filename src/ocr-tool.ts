/**
 * OCR Tool — text extraction from images using Tesseract.js.
 * Works offline, supports multiple languages.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { randomBytes } from "node:crypto";
import { execSync } from "node:child_process";

const TMP_DIR = join(homedir(), ".sax", "voice-tmp");
const TESS_DIR = join(homedir(), ".sax", "tesseract");
if (!existsSync(TMP_DIR)) mkdirSync(TMP_DIR, { recursive: true });
if (!existsSync(TESS_DIR)) mkdirSync(TESS_DIR, { recursive: true });

function tmpPath(ext: string): string {
  return join(TMP_DIR, `ocr_${randomBytes(6).toString("hex")}.${ext}`);
}

export interface OCROptions {
  /** Language(s) for recognition. Default: 'eng' */
  language?: string;
  /** Page segmentation mode (Tesseract PSM). Default: 3 (auto) */
  psm?: number;
  /** Whether to detect orientation and script */
  detectOrientation?: boolean;
  /** Preprocessing: sharpen, threshold, etc. */
  preprocess?: boolean;
}

export interface OCRResult {
  text: string;
  confidence: number;
  language: string;
  words: Array<{
    text: string;
    confidence: number;
    bbox: { x: number; y: number; width: number; height: number };
  }>;
  processingMs: number;
}

/** Run OCR using Tesseract.js via a Node script */
export async function recognizeText(
  imageInput: Buffer | string,
  options: OCROptions = {},
): Promise<OCRResult> {
  const start = Date.now();
  const lang = options.language ?? "eng";
  const psm = options.psm ?? 3;

  // Write image to temp file if buffer
  let imagePath: string;
  let tempImage = false;

  if (Buffer.isBuffer(imageInput)) {
    imagePath = tmpPath("png");
    writeFileSync(imagePath, imageInput);
    tempImage = true;
  } else {
    imagePath = imageInput;
  }

  const outPath = tmpPath("json");
  const scriptPath = tmpPath("mjs");

  // Generate a Node.js script that uses Tesseract.js
  const script = `
import Tesseract from 'tesseract.js';
import { writeFileSync } from 'fs';

const result = await Tesseract.recognize(
  '${imagePath.replace(/\\/g, "/")}',
  '${lang}',
  {
    logger: () => {},
    cachePath: '${TESS_DIR.replace(/\\/g, "/")}',
  }
);

const words = result.data.words.map(w => ({
  text: w.text,
  confidence: w.confidence,
  bbox: { x: w.bbox.x0, y: w.bbox.y0, width: w.bbox.x1 - w.bbox.x0, height: w.bbox.y1 - w.bbox.y0 },
}));

const output = {
  text: result.data.text,
  confidence: result.data.confidence,
  words,
};

writeFileSync('${outPath.replace(/\\/g, "/")}', JSON.stringify(output));
`.trim();

  try {
    writeFileSync(scriptPath, script, "utf-8");

    execSync(`node "${scriptPath}"`, {
      timeout: 60_000,
      stdio: "ignore",
      env: { ...process.env, NODE_OPTIONS: "" },
    });

    if (!existsSync(outPath)) throw new Error("OCR produced no output");

    const data = JSON.parse(readFileSync(outPath, "utf-8"));
    return {
      text: data.text?.trim() || "",
      confidence: data.confidence || 0,
      language: lang,
      words: data.words || [],
      processingMs: Date.now() - start,
    };
  } finally {
    if (tempImage) try { unlinkSync(imagePath); } catch {}
    try { unlinkSync(scriptPath); } catch {}
    try { unlinkSync(outPath); } catch {}
  }
}

/** Quick OCR — just returns the text string */
export async function extractText(imageInput: Buffer | string, language?: string): Promise<string> {
  const result = await recognizeText(imageInput, { language });
  return result.text;
}

/** OCR with native Tesseract CLI (if installed) — faster than Tesseract.js */
export function recognizeTextNative(
  imageInput: Buffer | string,
  options: OCROptions = {},
): OCRResult {
  const start = Date.now();
  const lang = options.language ?? "eng";
  const psm = options.psm ?? 3;

  let imagePath: string;
  let tempImage = false;

  if (Buffer.isBuffer(imageInput)) {
    imagePath = tmpPath("png");
    writeFileSync(imagePath, imageInput);
    tempImage = true;
  } else {
    imagePath = imageInput;
  }

  const outBase = tmpPath("txt").replace(".txt", "");

  try {
    execSync(
      `tesseract "${imagePath}" "${outBase}" -l ${lang} --psm ${psm} --oem 3`,
      { timeout: 30_000, stdio: "ignore" },
    );

    const textPath = outBase + ".txt";
    const text = existsSync(textPath) ? readFileSync(textPath, "utf-8").trim() : "";

    try { unlinkSync(textPath); } catch {}

    return {
      text,
      confidence: -1, // native CLI doesn't report confidence easily
      language: lang,
      words: [],
      processingMs: Date.now() - start,
    };
  } finally {
    if (tempImage) try { unlinkSync(imagePath); } catch {}
  }
}
