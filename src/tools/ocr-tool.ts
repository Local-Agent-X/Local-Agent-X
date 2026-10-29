/**
 * OCR: the text in an image, read on this computer by Tesseract (tesseract.js).
 *
 * The engine and its English data are npm dependencies, so nothing is
 * downloaded at run time and no image leaves the machine. Recognition runs in
 * the engine's own worker thread, so a page that takes seconds never blocks
 * the server. One worker is shared and is shut down after a minute idle.
 */

import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { createWorker, OEM, type Worker } from "tesseract.js";

const require = createRequire(import.meta.url);

/** The languages installed with LAX. Another language would need its data
 *  fetched at run time, outside the egress guard, so it is refused. */
export const OCR_LANGUAGES: readonly string[] = ["eng"];
/** The LSTM model in its integer form: the engine's own default, and the
 *  smallest and fastest of the package's two. */
const LANG_PATH = join(dirname(require.resolve("@tesseract.js-data/eng")), "4.0.0_best_int");
const IDLE_MS = 60_000;
const JOB_TIMEOUT_MS = 120_000;

export interface OCRResult {
  text: string;
  confidence: number;
  language: string;
  processingMs: number;
}

let worker: Promise<Worker> | null = null;
let idleTimer: NodeJS.Timeout | null = null;
let inFlight = 0;

function shutDown(): void {
  const current = worker;
  worker = null;
  if (current) current.then((w) => w.terminate()).catch(() => {});
}

function sharedWorker(): Promise<Worker> {
  if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; }
  if (!worker) {
    worker = createWorker("eng", OEM.LSTM_ONLY, { langPath: LANG_PATH, cacheMethod: "none", gzip: true });
    // A failed start is not kept: the next call tries again.
    worker.catch(() => { worker = null; });
  }
  return worker;
}

function scheduleIdleShutdown(): void {
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = setTimeout(shutDown, IDLE_MS);
  idleTimer.unref();
}

/** The text Tesseract reads in `image` (PNG, JPEG, WebP, BMP, TIFF bytes). */
export async function recognizeText(image: Buffer, language = "eng"): Promise<OCRResult> {
  if (!OCR_LANGUAGES.includes(language)) {
    throw new Error(`OCR language "${language.slice(0, 20)}" is not installed (installed: ${OCR_LANGUAGES.join(", ")})`);
  }
  const start = Date.now();
  inFlight++;
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`OCR took longer than ${JOB_TIMEOUT_MS / 1000}s`)), JOB_TIMEOUT_MS);
  });
  try {
    const w = await Promise.race([sharedWorker(), timeout]);
    const { data } = await Promise.race([w.recognize(image), timeout]);
    return { text: data.text.trim(), confidence: data.confidence, language, processingMs: Date.now() - start };
  } catch (e) {
    // A stuck or crashed engine is replaced rather than reused.
    shutDown();
    throw e;
  } finally {
    clearTimeout(timer);
    if (--inFlight === 0) scheduleIdleShutdown();
  }
}

/** Stop the engine now (tests, shutdown). */
export async function stopOcr(): Promise<void> {
  if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; }
  const current = worker;
  worker = null;
  if (current) await current.then((w) => w.terminate()).catch(() => {});
}
