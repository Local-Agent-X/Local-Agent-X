// Failing checks — which named tests or compiler errors a check run reports
// failing, read from its output. The verify-gate compares a post-edit run's
// list with the one the op saw before its first edit, so a test that was
// already red is not blamed on the edits.
//
// Strict on purpose, unlike build-verify's errorSignatures (every error-ish
// line, for a "what changed since the last retry" note): a name counts only
// from a line a runner prints per failure, never a summary line whose count
// changes between runs. Output no pattern recognizes yields no names, and the
// gate then treats the failure as new, as it did before it kept a baseline.

const ANSI_RE = /\x1b\[[0-9;]*m/g;
const DURATION_RE = /\s+\(?\d+(?:\.\d+)?\s*m?s\)?$/;

/** One pattern per runner's per-failure line; group 1 is the failure's name. */
const FAILURE_LINE_RES: readonly RegExp[] = [
  /^not ok \d+ - (.+?)(?:\s+#\s.*)?$/,                // TAP (node --test piped, tap reporters)
  /^[✖×✗] (.+)$/,                                     // node --test spec, vitest
  /^FAIL {1,2}(\S.*>.+)$/,                            // vitest: FAIL  file > suite > test
  /^● (.+)$/,                                         // jest
  /^(?:FAILED|ERROR) (\S+::\S+)/,                     // pytest
  /^(?:FAIL|ERROR): (\S+ \(.+\))$/,                   // python -m unittest
  /^--- FAIL: (\S+)/,                                 // go test
  /^test (\S+) \.\.\. FAILED$/,                       // cargo test
  /^(.+?)\(\d+,\d+\): error (TS\d+: .+)$/,            // tsc
  /^(.+?):\d+:\d+ - error (TS\d+: .+)$/,              // tsc --pretty
];

/** The failures a check run's output names, deduplicated. A runner's own
 *  section header ("✖ failing tests:") is not a failure. */
export function failingCheckNames(output: string): string[] {
  const names = new Set<string>();
  for (const raw of output.replace(ANSI_RE, "").split(/\r?\n/)) {
    const line = raw.trim();
    for (const re of FAILURE_LINE_RES) {
      const m = re.exec(line);
      if (!m) continue;
      const name = (m[2] ? `${m[1]}: ${m[2]}` : m[1]).replace(DURATION_RE, "").trim();
      if (name && !name.endsWith(":")) names.add(name);
      break;
    }
  }
  return [...names];
}
