/**
 * Side-effects extracted from loop.ts so the main loop file stays under
 * the 400-LOC ceiling. All three helpers — additive spec amendment,
 * chunk/spec commit, launch-readiness emission — are filesystem-touching
 * but otherwise pure functions of (projectDir, chunk, payload).
 */

import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve as resolvePath } from "node:path";
import type { ParsedChunk } from "./plan-parser.js";
import { gateAdditiveDiff } from "./chunk-review/gates.js";
import { gitAdd, gitCommit } from "./git-helpers.js";

export const LAUNCH_READINESS_FILENAME = "LAUNCH_READINESS.md";

export interface SpecAmendResult { appendedTo: string; bytesAppended: number; }

/**
 * Apply an additive spec amendment by appending to spec/build-state.md.
 * This file is the "spec gets longer over the build" sink the design
 * memo names — every clarification learned from a chunk lands here, never
 * in the load-bearing spec files like product.md or constitution.md
 * (those stay editor-only).
 *
 * Before writing, we synthesize a unified-diff snippet (pure additions,
 * no removals) and run it through the additive-diff gate as defense in
 * depth — even though the diff is structurally pure-add, the gate is the
 * one place we encode "is this safe?", so we always pass through it.
 */
export async function applyAdditiveSpecAmendment(
  projectDir: string,
  chunk: ParsedChunk,
  gapsText: string,
): Promise<{ ok: true; value: SpecAmendResult } | { ok: false; error: string }> {
  const targetRel = "spec/build-state.md";
  const targetAbs = resolvePath(projectDir, targetRel);

  const existing = existsSync(targetAbs) ? readFileSync(targetAbs, "utf-8") : "";
  const stamp = new Date().toISOString().slice(0, 10);
  const heading = `\n\n## Chunk ${chunk.number} — ${chunk.title} (added ${stamp})\n\n`;
  const addition = heading + gapsText.trim() + "\n";

  const synthDiff = [
    `--- a/${targetRel}`,
    `+++ b/${targetRel}`,
    `@@ -0,0 +0,0 @@`,
    ...addition.split("\n").map(l => "+" + l),
  ].join("\n");

  const gateFinding = gateAdditiveDiff(synthDiff);
  if (gateFinding) {
    return { ok: false, error: `additive-diff gate refused: ${gateFinding.reasoning}` };
  }

  try {
    if (existing) appendFileSync(targetAbs, addition);
    else writeFileSync(targetAbs, "# Build state — spec amendments captured during the build\n" + addition);
  } catch (e) {
    return { ok: false, error: `write ${targetRel} failed: ${(e as Error).message}` };
  }
  return { ok: true, value: { appendedTo: targetRel, bytesAppended: addition.length } };
}

export async function commitChunk(projectDir: string, chunk: ParsedChunk): Promise<{ sha: string; committed: boolean }> {
  await gitAdd(projectDir, ".");
  return gitCommit(projectDir, `chunk ${chunk.number}: ${chunk.title}`);
}

export async function commitSpecAmendment(projectDir: string, chunk: ParsedChunk): Promise<{ sha: string; committed: boolean }> {
  await gitAdd(projectDir, "spec/");
  return gitCommit(projectDir, `spec: chunk-${chunk.number} learned — ${chunk.title}`);
}

/**
 * Append a launch-readiness item to LAUNCH_READINESS.md in the project
 * root. Idempotency: the file gets a header on first write; subsequent
 * writes append. The loop doesn't try to dedup items — humans curate
 * the file before launch anyway.
 *
 * Best-effort. File-write failures don't halt the build because the
 * item is still recorded in the review outcome; LAUNCH_READINESS.md
 * is a convenience surface, not the source of truth.
 */
export function emitLaunchReadiness(projectDir: string, chunk: ParsedChunk, itemText: string): void {
  const target = resolvePath(projectDir, LAUNCH_READINESS_FILENAME);
  const stamp = new Date().toISOString().slice(0, 10);
  const entry =
    `\n## Chunk ${chunk.number} — ${chunk.title} (recorded ${stamp})\n\n` +
    itemText.trim() + "\n";
  try {
    if (existsSync(target)) appendFileSync(target, entry);
    else writeFileSync(target,
      "# Launch readiness\n\n" +
      "Items deferred from per-chunk verification because they require real third-party credentials, " +
      "HTTPS staging, or production data. **None of these may be deferred past public launch.** " +
      "Each entry must include a concrete \"how to verify\" step.\n" +
      entry,
    );
  } catch {
    // intentional swallow — see jsdoc
  }
}
