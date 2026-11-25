/**
 * Which figures of a deliverable have been checked, kept across restarts: what
 * "check the rest" reads. A routine check covers a sample (figure-inventory.ts
 * routineSampleSize), and the note says how many; when the user asks for the
 * rest, the ones on record here are skipped.
 *
 * A record belongs to the file as it was when it was checked (its size and
 * mtime). A file changed since by anyone but the check's own correction has
 * figures nobody checked, so its record no longer counts. The correction's own
 * edit moves the record along with it (`followCorrection`).
 */
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { getLaxDir } from "../lax-data-dir.js";
import { atomicWriteFileSync } from "../util/json-store.js";
import { figureFileKey } from "./figure-check-note.js";
import { artifactSignature } from "./verification-spend.js";

interface FileRecord {
  signature: string;
  /** Figure id → whether it matched when it was checked. */
  checked: Record<string, boolean>;
}

const ledgerPath = () => join(getLaxDir(), "figure-checks.json");

function load(): Record<string, FileRecord> {
  try {
    if (!existsSync(ledgerPath())) return {};
    const parsed = JSON.parse(readFileSync(ledgerPath(), "utf8")) as unknown;
    return parsed && typeof parsed === "object" ? parsed as Record<string, FileRecord> : {};
  } catch {
    return {}; // A torn or hand-edited file is no record: the next check starts over.
  }
}

function save(all: Record<string, FileRecord>): void {
  mkdirSync(dirname(ledgerPath()), { recursive: true });
  atomicWriteFileSync(ledgerPath(), JSON.stringify(all));
}

/** The figures checked in this file as it is now, each with whether it matched
 *  (empty when the file changed since). One that did not match stays open: the
 *  next check takes it first, which is how a correction is proved. */
export function figureLedger(path: string): Map<string, boolean> {
  const record = load()[figureFileKey(path)];
  if (!record || record.signature !== artifactSignature(path)) return new Map();
  return new Map(Object.entries(record.checked));
}

/** Record figures a check settled, for the file as it is now. */
export function recordCheckedFigures(path: string, results: Map<string, boolean>): void {
  if (results.size === 0) return;
  const signature = artifactSignature(path);
  if (signature === null) return;
  const all = load();
  const key = figureFileKey(path);
  const prior = all[key]?.signature === signature ? all[key].checked : {};
  all[key] = { signature, checked: { ...prior, ...Object.fromEntries(results) } };
  save(all);
}

/** The check's own correction rewrote the file: its record carries over. The
 *  corrected figures stay marked as not matching until a check confirms them. */
export function followCorrection(path: string): void {
  const signature = artifactSignature(path);
  const all = load();
  const key = figureFileKey(path);
  if (!all[key] || signature === null) return;
  all[key] = { ...all[key], signature };
  save(all);
}
