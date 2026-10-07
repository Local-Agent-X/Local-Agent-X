// Opt-in, content-addressed capture of prompt section text.
//
// Every op record already carries each prompt section's size and a short
// sha256 (prompt-telemetry.ts measurePromptSection), so which section changed
// between two turns is always answerable. What a section SAID is not: when an
// agent asserted something on one turn and called it invented on the next
// (2026-10-05), nothing on disk showed what memory either turn had seen. With
// LAX_PROMPT_CAPTURE=1 the text of each section is written once under its
// hash, ~/.lax/prompt-captures/<sha256>.txt, so an op record's section hash
// resolves to the exact text the model was given.
//
// The text is the user's most private material (recalled memory, profile), so:
// off unless the env flag is set, secrets redacted before the write, the
// directory and files owner-only, and captures older than RETENTION_MS are
// purged. A section that does not change between turns is stored once.
import { chmodSync, existsSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getLaxDir } from "./lax-data-dir.js";
import { redactString } from "./ops/redactor.js";

const RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const PURGE_EVERY_MS = 60 * 60 * 1000;
let lastPurgeAt = 0;

export function promptCaptureEnabled(): boolean {
  return process.env.LAX_PROMPT_CAPTURE === "1";
}

export function promptCaptureDir(): string {
  return join(getLaxDir(), "prompt-captures");
}

/** Write a section's text under its hash, once, when capture is on. Never
 *  throws: a failed capture must not fail the turn that is being captured. */
export function capturePromptSection(sha256: string, text: string, nowMs: number = Date.now()): void {
  if (!promptCaptureEnabled()) return;
  try {
    const dir = promptCaptureDir();
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
    chmodSync(dir, 0o700);
    const file = join(dir, `${sha256}.txt`);
    if (!existsSync(file)) writeFileSync(file, redactString(text).redacted, { mode: 0o600 });
    if (nowMs - lastPurgeAt >= PURGE_EVERY_MS) {
      lastPurgeAt = nowMs;
      purgeExpiredCaptures(nowMs);
    }
  } catch {
    // Diagnostics only; the turn proceeds without its capture.
  }
}

export function purgeExpiredCaptures(nowMs: number = Date.now()): number {
  const dir = promptCaptureDir();
  if (!existsSync(dir)) return 0;
  let removed = 0;
  for (const name of readdirSync(dir)) {
    const file = join(dir, name);
    if (nowMs - statSync(file).mtimeMs > RETENTION_MS) {
      rmSync(file, { force: true });
      removed++;
    }
  }
  return removed;
}

/** Test seam: reset the purge throttle. */
export function resetPromptCaptureForTest(): void {
  lastPurgeAt = 0;
}
