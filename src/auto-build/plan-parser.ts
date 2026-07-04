/**
 * Plan parser — reads an /app-build plan.md and extracts ordered chunks
 * with class (trunk/leaf/mixed) and done-when text.
 *
 * Expected shape (matches /app-build output, validated against Bookwell):
 *
 *   # <title>
 *   ## Phase A — Foundation
 *   ### Chunk 1 — Project skeleton
 *   - **Class:** trunk → `/senior-engineer`
 *   - **Slice:** ...
 *   - **Files:** src/foo.ts, src/bar.ts   (OPTIONAL — repo-relative paths this chunk
 *                will create/edit; comma/newline-separated → footprint. Omit if unknown.)
 *   - **Depends on:** —  | 1, 2
 *   - **Scenarios:** —   | 1, 2 (partial)
 *   - **Done when:** ...
 *   ## Phase B — ...
 *   ## Phase verification gates
 *   ### Phase D end-of-phase — partial scoring possible
 *   ## Launch readiness — deferred verification items
 *   | Item | From chunk | Why deferred | How to verify before launch |
 *
 * Tolerant of: em-dash vs hyphen, mixed-class free-form ("mixed: data
 * layer is trunk, UI is leaf"), missing scenarios/depends-on/files fields,
 * multi-line done-when with sub-bullets, optional bold markers. The
 * **Files:** bullet is optional — legacy plans predate it and still parse.
 *
 * What it does NOT do: validate the plan, judge chunk ordering, infer
 * missing fields. Garbage in → garbage out. Parser stays mechanical.
 */

import { readFileSync, existsSync } from "node:fs";

export type ChunkClass = "trunk" | "leaf" | "mixed";

export interface ParsedChunk {
  /** 1-indexed chunk number from the heading. */
  number: number;
  /** Chunk title (everything after "Chunk N — " in the H3). */
  title: string;
  /** Phase H2 heading this chunk lives under (e.g. "Phase A — Foundation"). */
  phase: string;
  /** Class extracted from the Class: bullet. Defaults to "mixed" if ambiguous. */
  klass: ChunkClass;
  /** Raw Slice: text (one line, multi-line collapsed). */
  slice: string;
  /** Chunk numbers this depends on. Empty if "—". */
  dependsOn: number[];
  /**
   * Repo-relative paths this chunk declares it will create/edit, from an optional
   * `**Files:**` bullet. Always a concrete array on parsed chunks (`[]` when absent);
   * optional only so pre-existing `ParsedChunk` literals compile. EMPTY = "undeclared",
   * NOT "touches nothing": downstream conflict scheduling MUST treat [] conservatively
   * (serialize, as if it conflicts with everything); only a non-empty footprint parallelizes.
   */
  footprint?: string[];
  /** Raw Scenarios: text, e.g. "1, 2 (partial)" or "—". */
  scenarios: string;
  /** Done-when text, multi-line preserved verbatim (sub-bullets included). */
  doneWhen: string;
  /** Full markdown source of this chunk's H3 section. Useful for review prompts. */
  rawSection: string;
}

export interface LaunchReadinessRow {
  item: string;
  fromChunk: string;
  whyDeferred: string;
  howToVerify: string;
}

export interface ParsedPlan {
  /** Top-level H1 if present, else empty. */
  title: string;
  /** Ordered list of chunks as they appear in the file. */
  chunks: ParsedChunk[];
  /** Phase verification gates section, as raw text. Empty if absent. */
  phaseGatesRawSection: string;
  /** Rows extracted from the Launch-readiness table. Empty if absent. */
  launchReadinessRows: LaunchReadinessRow[];
}

/**
 * Parse a plan.md file. Returns a structured ParsedPlan.
 *
 * Throws when the file doesn't exist OR no chunks parse — a plan with
 * zero chunks is almost certainly a wrong path or malformed file, and
 * surfacing the error early is better than silently returning {chunks:[]}.
 */
export function parsePlanFile(path: string): ParsedPlan {
  if (!existsSync(path)) throw new Error(`plan file not found: ${path}`);
  const text = readFileSync(path, "utf-8");
  return parsePlanText(text);
}

export function parsePlanText(text: string): ParsedPlan {
  const titleMatch = text.match(/^#\s+(.+?)\s*$/m);
  const title = titleMatch ? titleMatch[1].trim() : "";

  const chunks = extractChunks(text);
  const phaseGatesRawSection = extractH2Section(text, /^##\s+Phase\s+verification\s+gates\b/im);
  const launchReadinessRows = extractLaunchReadinessRows(text);

  if (chunks.length === 0) {
    throw new Error("plan parser: no chunks found — expected '### Chunk N — Title' headings");
  }
  const incomplete = chunks.filter((c) => !c.slice.trim() || !c.doneWhen.trim());
  if (incomplete.length > 0) {
    const details = incomplete.map((c) => {
      const missing = [
        !c.slice.trim() ? "Slice" : "",
        !c.doneWhen.trim() ? "Done when" : "",
      ].filter(Boolean).join(" + ");
      return `chunk ${c.number} (${missing})`;
    }).join(", ");
    throw new Error(
      `plan parser: incomplete chunk contract — ${details}. ` +
      `Each chunk needs a non-empty Slice and Done when; refusing to launch a worker with an empty scope or success contract.`
    );
  }

  return { title, chunks, phaseGatesRawSection, launchReadinessRows };
}

/**
 * Find all `### Chunk N — Title` sections. Phase context comes from the
 * most recent H2. Splits on H3 boundaries and slices the body up to the
 * next H2/H3 — preserving sub-bullets inside Done when.
 */
function extractChunks(text: string): ParsedChunk[] {
  const lines = text.split(/\r?\n/);
  const chunks: ParsedChunk[] = [];

  // Match the chunk H3. Tolerate em-dash (—), hyphen (-), or colon
  // between the number and title. Title is the rest of the line.
  // Examples: "### Chunk 1 — Project skeleton", "### Chunk 12: Booking lifecycle"
  const chunkH3 = /^###\s+Chunk\s+(\d+)\s*[—–\-:]\s*(.+?)\s*$/i;
  const phaseH2 = /^##\s+(?!Phase\s+verification\s+gates|Launch\s+readiness|Build\s+loop|Classification)(.+?)\s*$/i;

  let currentPhase = "";
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    const phaseMatch = line.match(phaseH2);
    if (phaseMatch) {
      currentPhase = phaseMatch[1].trim();
      i++;
      continue;
    }

    const chunkMatch = line.match(chunkH3);
    if (!chunkMatch) {
      i++;
      continue;
    }

    const number = Number(chunkMatch[1]);
    const titleText = chunkMatch[2].trim();
    const startLine = i;

    // Slurp until next H2 or H3 or EOF.
    let j = i + 1;
    while (j < lines.length) {
      const peek = lines[j];
      if (/^##\s+/.test(peek) || /^###\s+/.test(peek)) break;
      j++;
    }

    const rawSection = lines.slice(startLine, j).join("\n").trimEnd();
    const fields = parseChunkFields(rawSection);

    chunks.push({
      number,
      title: titleText,
      phase: currentPhase,
      klass: fields.klass,
      slice: fields.slice,
      dependsOn: fields.dependsOn,
      footprint: fields.footprint,
      scenarios: fields.scenarios,
      doneWhen: fields.doneWhen,
      rawSection,
    });
    i = j;
  }

  return chunks;
}

interface ChunkFields {
  klass: ChunkClass;
  slice: string;
  dependsOn: number[];
  footprint: string[];
  scenarios: string;
  doneWhen: string;
}

/**
 * Walk the chunk's body line-by-line. Lines starting with `- **Name:**`
 * open a new field; non-field lines append to the current field's body.
 * This is cleaner than a regex partition because Done when commonly spans
 * multiple lines with indented sub-bullets — those must NOT be misread as
 * new fields. (Sub-bullets are indented so they don't match the
 * column-0 field-bullet regex.)
 */
function parseChunkFields(rawSection: string): ChunkFields {
  const lines = rawSection.split(/\r?\n/).slice(1); // skip the H3 line itself

  const fieldBulletRe = /^[-*]\s+\*\*([A-Za-z][A-Za-z -]+?):\*\*\s*(.*)$/;
  // Legacy plans created before finalize_app_build enforced the canonical
  // bullet schema used standalone bold headings:
  //   **Goal**: ...
  //   **Files**:
  //   **Done-when**:
  // Parse that shape rather than launching with blank Slice/Done when. The
  // strict completeness check above still rejects prose that supplies neither.
  const fieldHeadingRe = /^\*\*([A-Za-z][A-Za-z -]+?)\*\*\s*:?\s*(.*)$/;
  const fields = new Map<string, string[]>();
  let currentKey: string | null = null;

  for (const line of lines) {
    const m = line.match(fieldBulletRe) || line.match(fieldHeadingRe);
    if (m) {
      currentKey = normalizeFieldKey(m[1]);
      const firstValueLine = m[2];
      if (!fields.has(currentKey)) fields.set(currentKey, []);
      // Even if the first line is empty (multi-line done-when style),
      // record it so the field exists.
      fields.get(currentKey)!.push(firstValueLine);
    } else if (currentKey) {
      fields.get(currentKey)!.push(line);
    }
  }

  const get = (k: string) => (fields.get(k) || []).join("\n").trim();
  const legacySlice = [
    get("goal"),
    get("files"),
    get("files to create"),
  ].filter(Boolean).join("\n");

  // Captured IN ADDITION to legacySlice: the same **Files:** text still feeds an
  // empty Slice (back-compat) AND now yields the structured file list.
  const rawFiles = [get("files"), get("files to create")].filter(Boolean).join("\n");

  return {
    klass: classifyChunkText(get("class")),
    slice: collapseWhitespace(get("slice") || legacySlice),
    dependsOn: parseDependsOn(get("depends on")),
    footprint: parseFootprint(rawFiles),
    scenarios: collapseWhitespace(get("scenarios")),
    doneWhen: get("done when"),
  };
}

function normalizeFieldKey(key: string): string {
  return key.trim().toLowerCase().replace(/-/g, " ").replace(/\s+/g, " ");
}

/**
 * Class detection: scan the Class: bullet text for the canonical words.
 * "mixed: data layer is trunk, UI is leaf" → mixed. Tie-break: if "mixed"
 * appears anywhere, return mixed. Otherwise prefer the first explicit
 * word found. Unknown → mixed (the design says: when in doubt, dispatch
 * to /senior-engineer, which the mapper does for mixed).
 */
export function classifyChunkText(text: string): ChunkClass {
  const t = text.toLowerCase();
  if (/\bmixed\b/.test(t)) return "mixed";
  // Order matters: check "trunk" before "leaf" — "trunk" appearing first
  // in mixed-form text still resolves correctly because we caught
  // "mixed" above. If both trunk and leaf appear without "mixed", that's
  // a malformed bullet — treat as mixed.
  const hasTrunk = /\btrunk\b/.test(t);
  const hasLeaf = /\bleaf\b/.test(t);
  if (hasTrunk && hasLeaf) return "mixed";
  if (hasTrunk) return "trunk";
  if (hasLeaf) return "leaf";
  return "mixed";
}

/**
 * Depends-on parser: "—", "-", or empty → []. Otherwise extract integers.
 * Accepts "1, 2, 3" or "1 and 2" or "prior chunks". Free-form text with
 * no integers → [] (caller decides whether that's a soft or hard miss).
 */
function parseDependsOn(text: string): number[] {
  const trimmed = text.trim();
  if (!trimmed || /^[—–\-]\s*$/.test(trimmed)) return [];
  const nums = trimmed.match(/\b\d+\b/g);
  if (!nums) return [];
  const out = new Set<number>();
  for (const n of nums) out.add(Number(n));
  return Array.from(out).sort((a, b) => a - b);
}

/**
 * Footprint parser: pull repo-relative paths from a chunk's optional **Files:** /
 * **Files to create:** bullet. Comma- OR newline-separated; tolerates list markers
 * (-, *) and inline-code backticks; de-dups, order kept. "—"/"-"/empty → []. Callers
 * must NOT read [] as "touches nothing" (see ParsedChunk.footprint) — empty serializes.
 */
function parseFootprint(text: string): string[] {
  const trimmed = text.trim();
  if (!trimmed || /^[—–\-]\s*$/.test(trimmed)) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const entry of trimmed.split(/[\n,]/)) {
    // Strip a leading list marker ("- "/"* ") then inline-code backticks.
    const path = entry.replace(/^\s*[-*]\s+/, "").replace(/`/g, "").trim();
    if (!path || /^[—–\-]$/.test(path) || seen.has(path)) continue;
    seen.add(path);
    out.push(path);
  }
  return out;
}

function collapseWhitespace(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

/**
 * Slice the text of a top-level H2 section by heading regex. Returns the
 * full section body (including the heading line) up to the next H2. Used
 * for the Phase-verification-gates section, which is downstream chunks
 * (phase-gate detector, chunk 6) consume.
 */
function extractH2Section(text: string, headingRe: RegExp): string {
  const lines = text.split(/\r?\n/);
  let start = -1;
  for (let i = 0; i < lines.length; i++) {
    if (headingRe.test(lines[i])) { start = i; break; }
  }
  if (start < 0) return "";
  let end = lines.length;
  for (let j = start + 1; j < lines.length; j++) {
    if (/^##\s+/.test(lines[j])) { end = j; break; }
  }
  return lines.slice(start, end).join("\n").trimEnd();
}

/**
 * Parse the Launch-readiness markdown table. Tolerates extra columns and
 * different column orders by matching on header text (case-insensitive,
 * partial). Returns empty array if no table found.
 */
function extractLaunchReadinessRows(text: string): LaunchReadinessRow[] {
  const section = extractH2Section(text, /^##\s+Launch\s+readiness\b/im);
  if (!section) return [];

  const lines = section.split(/\r?\n/);
  let headerIdx = -1;
  for (let i = 0; i < lines.length - 1; i++) {
    if (/^\s*\|.*\|.*$/.test(lines[i]) && /^\s*\|\s*[-:|\s]+\|.*$/.test(lines[i + 1])) {
      headerIdx = i;
      break;
    }
  }
  if (headerIdx < 0) return [];

  const headers = splitMarkdownRow(lines[headerIdx]).map(h => h.trim().toLowerCase());
  const idx = {
    item: findColumnIndex(headers, ["item", "what"]),
    fromChunk: findColumnIndex(headers, ["from chunk", "chunk"]),
    whyDeferred: findColumnIndex(headers, ["why deferred", "why", "reason"]),
    howToVerify: findColumnIndex(headers, ["how to verify", "verify"]),
  };

  const rows: LaunchReadinessRow[] = [];
  for (let i = headerIdx + 2; i < lines.length; i++) {
    const line = lines[i];
    if (!/^\s*\|/.test(line)) break;
    const cells = splitMarkdownRow(line);
    if (cells.length < 2) continue;
    rows.push({
      item: cells[idx.item] || "",
      fromChunk: cells[idx.fromChunk] || "",
      whyDeferred: cells[idx.whyDeferred] || "",
      howToVerify: cells[idx.howToVerify] || "",
    });
  }
  return rows;
}

function splitMarkdownRow(line: string): string[] {
  const trimmed = line.trim().replace(/^\|/, "").replace(/\|\s*$/, "");
  return trimmed.split("|").map(c => c.trim());
}

function findColumnIndex(headers: string[], candidates: string[]): number {
  for (let i = 0; i < headers.length; i++) {
    for (const c of candidates) {
      if (headers[i].includes(c)) return i;
    }
  }
  return -1;
}
