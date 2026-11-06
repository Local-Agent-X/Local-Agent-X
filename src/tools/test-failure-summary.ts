/**
 * The failing tests in a failed test run's output, as a short list at the head of
 * the bash result: each test's name, where it failed (file:line) and the first line
 * of why. A runner's own report buries them in progress lines, diffs and stack
 * frames, and a long one is cut before the agent reads its end; the agent then
 * re-runs the suite or greps its own output. Read from the runners' default
 * reporters, so it works on the command the agent already ran (no second way to
 * run a command):
 *   vitest  " FAIL  file > suite > test", then the error, then " ❯ file:line:col"
 *   jest    " ● suite › test", then the error, then "at … (file:line:col)"
 *   pytest  "FAILED file::test - message", and "file:line: Error" in the detail
 * Output from anything else yields nothing: no list beats a wrong one.
 */

export interface FailingTest {
  name: string;
  /** file:line, when the report names it. */
  at?: string;
  message?: string;
}

const MAX_LISTED = 10;
const MAX_MESSAGE = 200;
const ANSI = /\x1b\[[0-9;]*m/g;

const short = (s: string): string => (s.length > MAX_MESSAGE ? `${s.slice(0, MAX_MESSAGE)}…` : s);

/** The block of lines under each header, up to the next header or a rule line. */
function blocks(lines: string[], header: RegExp): Array<{ head: RegExpMatchArray; body: string[] }> {
  const out: Array<{ head: RegExpMatchArray; body: string[] }> = [];
  for (const line of lines) {
    const m = line.match(header);
    if (m) { out.push({ head: m, body: [] }); continue; }
    const cur = out[out.length - 1];
    if (cur && !/^\s*⎯{3,}/.test(line)) cur.body.push(line);
  }
  return out;
}

const firstText = (body: string[]): string | undefined => body.map((l) => l.trim()).find((l) => l !== "");

function vitestFailures(lines: string[]): FailingTest[] {
  // The detail header names the test (file > … > name); the per-file summary
  // line (" FAIL  file") and the "×" progress lines have no " > " and are skipped.
  return blocks(lines, /^\s*FAIL\s+(\S+)\s+>\s+(.+?)\s*$/).map(({ head, body }) => {
    const loc = body.map((l) => l.match(/❯\s+(\S+?):(\d+):\d+/)).find(Boolean);
    return { name: `${head[1]} > ${head[2]}`, at: loc ? `${loc[1]}:${loc[2]}` : head[1], message: firstText(body) };
  });
}

function jestFailures(lines: string[]): FailingTest[] {
  return blocks(lines, /^\s*●\s+(.+?)\s*$/).filter(({ head }) => !/^Console$/.test(head[1] ?? "")).map(({ head, body }) => {
    const loc = body.map((l) => l.match(/\bat .*?\(?([^\s()]+\.[cm]?[jt]sx?):(\d+):\d+\)?\s*$/)).find(Boolean);
    return { name: head[1]!, ...(loc ? { at: `${loc[1]}:${loc[2]}` } : {}), message: firstText(body) };
  });
}

function pytestFailures(lines: string[], text: string): FailingTest[] {
  return lines.flatMap((line) => {
    const m = line.match(/^FAILED\s+(\S+?)::(\S+)(?:\s+-\s+(.*))?$/);
    if (!m) return [];
    const file = m[1]!;
    const loc = text.match(new RegExp(`^${file.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}:(\\d+):`, "m"));
    return [{ name: `${file}::${m[2]}`, ...(loc ? { at: `${file}:${loc[1]}` } : { at: file }), ...(m[3] ? { message: m[3] } : {}) }];
  });
}

/** Each failing test once: jest repeats every failure under "Summary of all failing tests". */
function once(tests: FailingTest[]): FailingTest[] {
  const seen = new Set<string>();
  return tests.filter((t) => !seen.has(t.name) && (seen.add(t.name), true));
}

export function failingTests(output: string): FailingTest[] {
  const text = output.replace(ANSI, "").replace(/\r\n/g, "\n");
  const lines = text.split("\n");
  const found = vitestFailures(lines);
  if (found.length > 0) return once(found);
  const pytest = pytestFailures(lines, text);
  if (pytest.length > 0) return once(pytest);
  return /^\s*(FAIL|PASS)\s+\S/m.test(text) ? once(jestFailures(lines)) : [];
}

/** The list to put at the head of a failed run's result; null when the output
 *  names no failing test. */
export function failingTestsSummary(output: string): string | null {
  const tests = failingTests(output);
  if (tests.length === 0) return null;
  const listed = tests.slice(0, MAX_LISTED).map((t, i) =>
    `${i + 1}. ${t.name}${t.at ? `\n   at ${t.at}` : ""}${t.message ? `\n   ${short(t.message)}` : ""}`);
  const more = tests.length > MAX_LISTED ? `\n(+${tests.length - MAX_LISTED} more in the output below)` : "";
  return `Failing tests (${tests.length}):\n${listed.join("\n")}${more}`;
}
