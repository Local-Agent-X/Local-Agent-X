/**
 * Prior-build memory for build_app UPDATE flows.
 *
 * Every update used to start cold: a fresh op whose only context was a file
 * snapshot, so the "fixer" had no idea what the app was originally asked to
 * be or what the last build claimed to have done — it re-diagnosed from
 * scratch and tended to repeat the same wrong approach. This module gives an
 * update op the prior session's spine: for the most recent completed builds
 * of the SAME app, the brief that drove each one and the builder's final
 * report.
 *
 * Rendered as an `=== ... ===` block that rides the existing contextFiles
 * seam in renderPerBuildContext, so BOTH build strategies (cli-subprocess
 * and in-canonical) inherit it with no adapter changes. Pure renderers at
 * the bottom; the store-touching gatherer on top.
 */

import { existsSync } from "node:fs";
import { listOps } from "../ops/op-store.js";
import { readOpMessages, firstUserMessageText } from "../canonical-loop/index.js";
import { VERIFY_EVIDENCE_MARKER } from "../canonical-loop/public/build-adapters.js";

/** Most recent prior builds included. Newest last (chronological read). */
const MAX_PRIOR_OPS = 3;
const BRIEF_CAP = 1_500;
const REPORT_CAP = 2_000;
const GATE_CAP = 1_500;

export interface PriorBuildEntry {
  createdAt: string;
  /** "completed" | "failed" — a failed fix attempt is exactly what the next
   *  fixer must know about (so it doesn't repeat the same broken approach). */
  status: string;
  /** The user's build/update instruction that drove the op. */
  brief: string;
  /** The builder's final assistant message (its closing report). */
  finalReport: string;
  /** The verify gate's rejection (smoke / vision judge), when the build was
   *  flipped to failed AT the terminal — the ground truth the final report's
   *  APP_READY claim contradicts. */
  gateFailure?: string;
  /** Screenshot evidence the gate attached to its rejection. filePath refs
   *  only — bytes are read at request time by the transports. */
  evidence?: Array<{ name: string; filePath: string }>;
}

/**
 * Collect the terminal prior build ops for an app, oldest→newest. Matched
 * by appUrl — unique per app directory and stamped on every app_build op.
 * `opType` is passed by the caller (build-app.ts owns APP_BUILD_OP_TYPE;
 * importing it here would be a cycle).
 */
export function gatherPriorBuildSessions(appUrl: string, opType: string): PriorBuildEntry[] {
  const prior = listOps()
    .filter((op) => op.type === opType && op.appUrl === appUrl
      && (op.status === "completed" || op.status === "failed"))
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
    .slice(-MAX_PRIOR_OPS);

  const entries: PriorBuildEntry[] = [];
  for (const op of prior) {
    const brief = extractBuildBrief(firstUserMessageText(op.id));
    const rows = readOpMessages(op.id);
    const finalReport = lastAssistantText(rows);
    const gate = lastVerifyEvidence(rows);
    if (!brief && !finalReport && !gate) continue;
    entries.push({
      createdAt: op.createdAt,
      status: op.status,
      brief: brief.slice(0, BRIEF_CAP),
      finalReport: finalReport.slice(0, REPORT_CAP),
      ...(gate ? { gateFailure: gate.detail.slice(0, GATE_CAP), evidence: gate.evidence } : {}),
    });
  }
  return entries;
}

/**
 * The verify gate's failure evidence row: a user message the gate appended at
 * the failed terminal, marker-prefixed, optionally carrying screenshot image
 * refs. Newest wins when a poison op somehow failed the gate more than once.
 */
function lastVerifyEvidence(
  rows: ReturnType<typeof readOpMessages>,
): { detail: string; evidence: Array<{ name: string; filePath: string }> } | null {
  for (let i = rows.length - 1; i >= 0; i--) {
    const row = rows[i];
    if (row.role !== "user") continue;
    const c = row.content as { text?: unknown; images?: unknown } | null;
    const text = c && typeof c === "object" && typeof c.text === "string" ? c.text : "";
    if (!text.startsWith(VERIFY_EVIDENCE_MARKER)) continue;
    const evidence: Array<{ name: string; filePath: string }> = [];
    if (Array.isArray(c?.images)) {
      for (const img of c.images) {
        const o = img as { name?: unknown; filePath?: unknown };
        if (typeof o?.name === "string" && typeof o?.filePath === "string") {
          evidence.push({ name: o.name, filePath: o.filePath });
        }
      }
    }
    return { detail: text.slice(VERIFY_EVIDENCE_MARKER.length).trim(), evidence };
  }
  return null;
}

/**
 * Screenshot evidence for the NEXT build's seeded user message: the newest
 * prior entry that carries gate evidence, filtered to files still on disk
 * (the gate rewrites .lax-build/smoke*.png per run — a pruned or moved app
 * dir simply attaches nothing). Shape matches the canonical user-image
 * envelope; url stays empty because transports read bytes from filePath.
 */
export function evidenceImagesFromPriorSessions(
  entries: PriorBuildEntry[],
): Array<{ url: string; name: string; filePath: string }> {
  for (let i = entries.length - 1; i >= 0; i--) {
    const evidence = entries[i].evidence;
    if (!evidence || evidence.length === 0) continue;
    return evidence
      .filter((e) => existsSync(e.filePath))
      .map((e) => ({ url: "", name: e.name, filePath: e.filePath }));
  }
  return [];
}

/**
 * The seeded turn-0 user message is the whole rendered per-build context;
 * the actual ask lives on its `Instructions:` line. Pull just that; fall
 * back to the raw text when the shape is unfamiliar.
 */
export function extractBuildBrief(seededText: string): string {
  const m = seededText.match(/^Instructions: ([\s\S]*?)\n\nRULES:/m);
  return (m ? m[1] : seededText).trim();
}

function lastAssistantText(rows: ReturnType<typeof readOpMessages>): string {
  for (let i = rows.length - 1; i >= 0; i--) {
    const row = rows[i];
    if (row.role !== "assistant") continue;
    const c = row.content;
    const text = typeof c === "string"
      ? c
      : (c && typeof c === "object" && typeof (c as { text?: unknown }).text === "string")
        ? (c as { text: string }).text
        : "";
    if (text.trim()) return text.trim();
  }
  return "";
}

/**
 * Render the entries as one context block, or null when there's no history
 * (an app created before this feature, or pruned ops — the update then runs
 * exactly as it did before).
 */
export function renderPriorBuildBlock(entries: PriorBuildEntry[]): string | null {
  if (entries.length === 0) return null;
  const parts = entries.map((e) => {
    const day = e.createdAt.slice(0, 10);
    const tag = e.status === "failed" ? " (BUILD FAILED — do not repeat this approach)" : "";
    const lines = [`[${day}] brief: ${e.brief || "(unavailable)"}`];
    if (e.finalReport) lines.push(`[${day}] builder's final report${tag}: ${e.finalReport}`);
    if (e.gateFailure) lines.push(`[${day}] verify gate REJECTED that build (this is the ground truth, not the report above): ${e.gateFailure}`);
    return lines.join("\n");
  });
  return (
    `=== PRIOR BUILD SESSIONS (you are CONTINUING this app, not starting fresh) ===\n` +
    `This app was built through the session(s) below. Honor the original brief; ` +
    `treat past "final report" claims as UNVERIFIED — if the user is asking for a fix, ` +
    `something in them was wrong.\n\n${parts.join("\n\n")}`
  );
}
