/**
 * The docs a framework creator wrote, recorded when the kit lands so the kit's
 * own doc-path check (kit/check-doc-paths.mjs) does not hold the project to a
 * template's README: Astro's names `src/components/`, which the starter does
 * not have. The check skips a recorded doc while its content hash matches and
 * checks it like any other once edited. The record's format is the kit
 * script's (its header); this is the only writer.
 */
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { STOCK_DOCS_MANIFEST } from "./kit-files.js";

// Every markdown file outside installed dependencies: a superset of the docs
// the check reads, so the record never misses one and an extra row is inert.
function markdownFiles(projectDir: string, rel = ""): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(join(projectDir, rel), { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === ".git") continue;
    const path = rel ? `${rel}/${entry.name}` : entry.name;
    if (entry.isDirectory()) out.push(...markdownFiles(projectDir, path));
    else if (entry.name.endsWith(".md")) out.push(path);
  }
  return out;
}

/** The check's hash: sha256 of the text with CRLF read as LF, so a checkout
 *  that converts line endings does not read as an edit. */
export function stockDocHash(text: string): string {
  return createHash("sha256").update(text.replace(/\r\n/g, "\n")).digest("hex");
}

/**
 * Record the markdown in a project the kit has just landed in for the first
 * time, minus the files the kit wrote (`kitWritten`): what is left came with
 * the project. An existing record is never replaced, and nothing is written
 * when there is nothing to record. Returns the recorded paths.
 */
export function recordCreatorDocs(projectDir: string, kitWritten: ReadonlySet<string>): string[] {
  const manifest = join(projectDir, STOCK_DOCS_MANIFEST);
  if (existsSync(manifest)) return [];
  const docs: Record<string, string> = {};
  for (const rel of markdownFiles(projectDir)) {
    if (kitWritten.has(rel)) continue;
    docs[rel] = stockDocHash(readFileSync(join(projectDir, rel), "utf-8"));
  }
  const paths = Object.keys(docs);
  if (paths.length) writeFileSync(manifest, JSON.stringify({ docs }, null, 2) + "\n", "utf-8");
  return paths;
}
