/**
 * Parse the agent's structured chunk-completion report.
 *
 * The skill-mapper prompt instructs the subprocess to end with a fixed
 * block (STATUS / DONE_WHEN / CHANGED / TESTS / NEW_FAILURES /
 * PRE_EXISTING_FAILURES / SPEC_GAPS / LAUNCH_READINESS / NOTE). This
 * parser pulls those fields out so the gate logic can reason over them
 * directly rather than scraping prose.
 *
 * The parser is permissive in one direction (free-form NOTE bodies) and
 * strict in the other (each named field must appear at column 0 with the
 * exact uppercase prefix). If a chunk subprocess returns a malformed
 * block, the report's `status` defaults to "unknown" and downstream gates
 * treat that as a halt — the loop should not commit to main when the
 * report shape is wrong, even if the prose sounds successful.
 */

export type ReportStatus = "done" | "blocked" | "partial" | "unknown";
export type ReportDoneWhen = "met" | "deferred-to-launch-readiness" | "unmet" | "unknown";

export interface ChunkReport {
  status: ReportStatus;
  doneWhen: ReportDoneWhen;
  changed: string[];
  testsPass: number | null;
  testsTotal: number | null;
  newFailures: string[];
  preExistingFailures: string[];
  /** Free-form text after `SPEC_GAPS:`. "none" → empty string. */
  specGaps: string;
  /** Free-form text after `LAUNCH_READINESS:`. "none" → empty string. */
  launchReadiness: string;
  /** Free-form NOTE body. The Calenbella incident transcripts showed
   *  that critical context (Constitution-violation gray areas, silent
   *  fallbacks, integration-test deferrals) often only appears in NOTE
   *  prose — gates must read it too, not just the structured fields. */
  note: string;
  /** True if the parser could find at least STATUS + DONE_WHEN.
   *  False ⇒ shape is malformed and gates should halt. */
  parsed: boolean;
}

const FIELD_NAMES = [
  "STATUS",
  "DONE_WHEN",
  "CHANGED",
  "TESTS",
  "NEW_FAILURES",
  "PRE_EXISTING_FAILURES",
  "SPEC_GAPS",
  "LAUNCH_READINESS",
  "NOTE",
] as const;

export function parseChunkReport(raw: string): ChunkReport {
  // Walk lines; each FIELD: starts a new bucket; everything until the
  // next field (or EOF) accumulates as that field's body. This handles
  // multi-line NOTE / SPEC_GAPS / LAUNCH_READINESS without surprises.
  const lines = raw.split(/\r?\n/);
  const buckets = new Map<string, string[]>();
  let current: string | null = null;

  const fieldRe = new RegExp(`^(${FIELD_NAMES.join("|")}):\\s?(.*)$`);

  for (const line of lines) {
    const m = line.match(fieldRe);
    if (m) {
      current = m[1];
      if (!buckets.has(current)) buckets.set(current, []);
      buckets.get(current)!.push(m[2]);
    } else if (current) {
      buckets.get(current)!.push(line);
    }
  }

  const get = (k: string) => (buckets.get(k) || []).join("\n").trim();

  const statusRaw = get("STATUS").toLowerCase();
  const doneWhenRaw = get("DONE_WHEN").toLowerCase();

  const status: ReportStatus =
    statusRaw === "done" || statusRaw === "blocked" || statusRaw === "partial"
      ? statusRaw
      : "unknown";

  let doneWhen: ReportDoneWhen = "unknown";
  if (doneWhenRaw === "met") doneWhen = "met";
  else if (doneWhenRaw.includes("deferred")) doneWhen = "deferred-to-launch-readiness";
  else if (doneWhenRaw === "unmet" || doneWhenRaw === "not met") doneWhen = "unmet";

  const changed = parseListField(get("CHANGED"));
  const newFailures = parseListField(get("NEW_FAILURES"));
  const preExistingFailures = parseListField(get("PRE_EXISTING_FAILURES"));
  const { pass, total } = parseTestsField(get("TESTS"));

  const specGapsRaw = get("SPEC_GAPS");
  const launchReadinessRaw = get("LAUNCH_READINESS");
  const noteRaw = get("NOTE");

  return {
    status,
    doneWhen,
    changed,
    testsPass: pass,
    testsTotal: total,
    newFailures,
    preExistingFailures,
    specGaps: normalizeListText(specGapsRaw),
    launchReadiness: normalizeListText(launchReadinessRaw),
    note: noteRaw,
    parsed: buckets.has("STATUS") && buckets.has("DONE_WHEN"),
  };
}

/**
 * Split a CHANGED / NEW_FAILURES / PRE_EXISTING_FAILURES field into
 * items. Tolerates commas, newlines, "none", em-dash. Returns [] for
 * empty/none.
 */
function parseListField(text: string): string[] {
  const t = text.trim();
  if (!t || isNoneLike(t)) return [];
  return t
    .split(/[,\n]+/)
    .map(s => s.trim())
    .filter(Boolean)
    .filter(s => !isNoneLike(s));
}

function parseTestsField(text: string): { pass: number | null; total: number | null } {
  const t = text.trim();
  if (!t || /^n\/a/i.test(t)) return { pass: null, total: null };
  const m = t.match(/(\d+)\s*\/\s*(\d+)/);
  if (!m) return { pass: null, total: null };
  return { pass: Number(m[1]), total: Number(m[2]) };
}

/** "none" / "—" / "n/a" → empty string. Otherwise return as-is (trimmed). */
function normalizeListText(text: string): string {
  const t = text.trim();
  if (isNoneLike(t)) return "";
  return t;
}

function isNoneLike(t: string): boolean {
  return /^(none|—|-|n\/a|nothing|null)$/i.test(t.trim());
}
