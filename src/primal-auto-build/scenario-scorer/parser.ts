/**
 * Parse a scenario .md file into {persona, steps, passCriteria}.
 *
 * Format (matches what /app-build emits, validated against Calenbella +
 * mygroomtime scenarios):
 *
 *   # Scenario NN — Title
 *
 *   **Persona:** ... (one paragraph)
 *
 *   **Steps:**
 *   1. ...
 *   2. ...
 *
 *   **Pass criteria:** ...
 *
 * Loose tolerance: optional Persona, alternate punctuation, blank lines
 * between fields. Strict on the Steps: list — without ordered steps, the
 * scenario can't be driven, so we throw rather than silently scoring 0.
 */

import { readFileSync, existsSync } from "node:fs";
import type { ParsedScenario } from "./types.js";

export function parseScenarioFile(path: string): ParsedScenario {
  if (!existsSync(path)) throw new Error(`scenario file not found: ${path}`);
  const raw = readFileSync(path, "utf-8");
  return parseScenarioText(raw, path);
}

export function parseScenarioText(raw: string, path: string): ParsedScenario {
  const title = (raw.match(/^#\s+(.+?)\s*$/m) || [])[1]?.trim() || "(untitled scenario)";
  const persona = matchBoldField(raw, "Persona") || "";
  const passCriteria = matchBoldField(raw, "Pass criteria") || "";
  const steps = parseStepList(raw);

  if (steps.length === 0) {
    throw new Error(`scenario ${path} has no Steps: list — cannot drive`);
  }

  return { path, title, persona, steps, passCriteria, raw };
}

/**
 * Find a bolded label like `**Persona:** value` and return value up to
 * the next blank line or the next bolded label. Multi-line tolerant.
 */
function matchBoldField(raw: string, label: string): string {
  const re = new RegExp(`\\*\\*${label}:\\*\\*\\s*([\\s\\S]*?)(?=\\n\\s*\\n|\\n\\s*\\*\\*[A-Z][^\\*]*?:\\*\\*|$)`, "i");
  const m = raw.match(re);
  if (!m) return "";
  return m[1].trim();
}

/**
 * Parse the ordered Steps: list. We look for the `**Steps:**` marker and
 * then consume every line that starts with a number + dot (or bullet)
 * up to a blank line or the next bolded section.
 */
function parseStepList(raw: string): string[] {
  const stepsMarker = /\*\*Steps:\*\*\s*\n/i;
  const m = raw.match(stepsMarker);
  if (!m) return [];

  const start = m.index! + m[0].length;
  const rest = raw.slice(start);
  const out: string[] = [];

  for (const line of rest.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) {
      if (out.length > 0) break; // blank line after some steps → end of list
      continue;
    }
    if (/^\*\*[A-Z]/.test(trimmed)) break; // next bolded field → end of list
    const num = trimmed.match(/^(\d+)\.\s*(.+)$/);
    if (num) {
      out.push(num[2]);
      continue;
    }
    const bullet = trimmed.match(/^[-*]\s+(.+)$/);
    if (bullet) {
      out.push(bullet[1]);
      continue;
    }
    // Continuation line — append to previous step.
    if (out.length > 0) out[out.length - 1] += " " + trimmed;
  }

  return out;
}
