/**
 * What the device check reads and decides — pure, no adb (device-check-tool.ts
 * runs it). A phone app's finish gate (the /greenfield skill,
 * references/gates.md section 1) needs evidence from the device itself: every
 * stage of the core flow ran there, where and how long, and none of the
 * user's data reached the log. On 2026-11-23 a build was "tested on the phone"
 * by installing it and opening it; its core flow failed, and nothing on the
 * device said where, because the app logged none of its own steps.
 *
 * The project says what to look for in `.lax-device.json` at its root:
 *
 *   { "package": "app.labelcheck", "tag": "LabelCheck",
 *     "stages": ["photo", "ocr", "extract", "match", "result"],
 *     "private": ["Testamycin"] }
 *
 * and its app logs each stage as `<tag> stage=<name>`, optionally with
 * `where=<device|cloud>` and `ms=<n>`, either as the message's own text (a JS
 * console line) or under the log tag itself (`Log.i("LabelCheck", "stage=ocr")`).
 * `private` lists the test values entered on the phone for the run (a test
 * medication, a test name) that must never reach the log; `[]` says the app
 * keeps no user data, and leaving it out is not allowed, so the question is
 * always answered.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export const DEVICE_SPEC_FILENAME = ".lax-device.json";

export interface DeviceSpec {
  package: string;
  tag: string;
  stages: string[];
  private: string[];
}

/** The project's device spec, or why it cannot be used. */
export function readDeviceSpec(projectDir: string): DeviceSpec | { error: string } {
  const file = join(projectDir, DEVICE_SPEC_FILENAME);
  if (!existsSync(file)) return { error: `${projectDir} has no ${DEVICE_SPEC_FILENAME}.` };
  let raw: unknown;
  try { raw = JSON.parse(readFileSync(file, "utf8")); }
  catch (e) { return { error: `${DEVICE_SPEC_FILENAME} is not valid JSON: ${(e as Error).message}` }; }
  const r = (raw ?? {}) as Record<string, unknown>;
  const strings = (v: unknown) => Array.isArray(v) && v.every((s) => typeof s === "string" && s.trim()) ? (v as string[]).map((s) => s.trim()) : null;
  const stages = strings(r.stages);
  const priv = strings(r.private);
  const missing = [
    typeof r.package === "string" && r.package.trim() ? null : "`package` (the app id)",
    typeof r.tag === "string" && /^[\w.-]+$/.test(r.tag) ? null : "`tag` (letters, digits, . _ -)",
    stages && stages.length > 0 ? null : "`stages` (the core flow's stage names, in order)",
    priv ? null : "`private` (test values that must never reach the log, or [] when the app keeps no user data)",
  ].filter(Boolean);
  if (missing.length) return { error: `${DEVICE_SPEC_FILENAME} needs ${missing.join(", ")}.` };
  return { package: (r.package as string).trim(), tag: r.tag as string, stages: stages!, private: priv! };
}

export interface StageSeen {
  stage: string;
  /** Milliseconds into the day the line was logged (threadtime, device clock). */
  at: number;
  where?: string;
  ms?: number;
}

export interface Leak {
  /** Index into spec.private: the ledger never names the value itself. */
  index: number;
  lines: number;
  /** The log tags of the lines it was found on. */
  tags: string[];
}

export interface DeviceLogReport {
  lines: number;
  /** The latest run of the flow: each stage once, in the order logged. */
  run: StageSeen[];
  missing: string[];
  leaks: Leak[];
}

const THREADTIME = /^\d\d-\d\d (\d\d):(\d\d):(\d\d)\.(\d{3})\s+\d+\s+\d+\s+[VDIWEF]\s+([^:]*?)\s*:\s?(.*)$/;

function stageOf(line: string, tag: string): StageSeen | null {
  const m = THREADTIME.exec(line);
  if (!m) return null;
  const [, h, mi, s, ms, logTag, message] = m;
  const own = logTag === tag ? message : message.startsWith(tag + " ") ? message.slice(tag.length + 1) : null;
  const stage = own === null ? null : /(?:^|\s)stage=([\w.-]+)/.exec(own);
  if (!stage) return null;
  const where = /(?:^|\s)where=([\w-]+)/.exec(own!)?.[1];
  const took = /(?:^|\s)ms=(\d+)/.exec(own!)?.[1];
  const at = ((Number(h) * 60 + Number(mi)) * 60 + Number(s)) * 1000 + Number(ms);
  return { stage: stage[1], at, ...(where ? { where } : {}), ...(took ? { ms: Number(took) } : {}) };
}

/** Read a `logcat -d -v threadtime` dump against the spec. The latest run
 *  starts at the last line logging the first stage. */
export function analyzeDeviceLog(log: string, spec: DeviceSpec): DeviceLogReport {
  const lines = log.split(/\r?\n/).filter(Boolean);
  const seen = lines.map((l) => stageOf(l, spec.tag)).filter((s): s is StageSeen => s !== null);
  let from = -1;
  seen.forEach((s, i) => { if (s.stage === spec.stages[0]) from = i; });
  const run: StageSeen[] = [];
  if (from >= 0) for (const s of seen.slice(from)) if (!run.some((r) => r.stage === s.stage)) run.push(s);
  const missing = spec.stages.filter((name) => !run.some((r) => r.stage === name));
  const leaks: Leak[] = [];
  spec.private.forEach((value, index) => {
    const needle = value.toLowerCase();
    const hits = lines.filter((l) => l.toLowerCase().includes(needle));
    if (hits.length) leaks.push({ index, lines: hits.length, tags: [...new Set(hits.map((l) => THREADTIME.exec(l)?.[5] ?? "?"))] });
  });
  return { lines: lines.length, run, missing, leaks };
}

export interface DeviceCheckFacts {
  date: string;
  device: { serial: string; model: string; android: string };
  spec: DeviceSpec;
  installed: boolean;
  report: DeviceLogReport;
}

export function deviceCheckPassed(f: DeviceCheckFacts): boolean {
  return f.installed && f.report.missing.length === 0 && f.report.leaks.length === 0;
}

/** The ledger line: what the harness saw, never a test value itself (the
 *  ledger is committed, and the repo may go public). */
export function deviceLedgerLine(f: DeviceCheckFacts): string {
  const { report, spec } = f;
  const stages = report.run.map((s) => `${s.stage}${s.where || s.ms !== undefined ? ` (${[s.where, s.ms !== undefined ? `${s.ms} ms` : ""].filter(Boolean).join(", ")})` : ""}`).join(" → ");
  const span = report.run.length > 1 ? `, ${((report.run[report.run.length - 1].at - report.run[0].at) / 1000).toFixed(1)} s first to last` : "";
  const privacy = spec.private.length === 0
    ? "No test values declared (the app keeps no user data)."
    : report.leaks.length === 0
      ? `Searched ${report.lines} log lines for ${spec.private.length} test value${spec.private.length === 1 ? "" : "s"}: none found.`
      : `LEAK: ${report.leaks.map((l) => `test value ${l.index + 1} on ${l.lines} line${l.lines === 1 ? "" : "s"} (log tag ${l.tags.join(", ")})`).join("; ")}.`;
  return `- ${f.date} device check (device_check, run by LAX): ${deviceCheckPassed(f) ? "PASS" : "FAIL"} on ${f.device.model}, ` +
    `Android ${f.device.android} (${f.device.serial}), app ${spec.package}${f.installed ? "" : " NOT INSTALLED"}. ` +
    `Stages: ${stages || "none logged"}${span}.` +
    (report.missing.length ? ` Missing: ${report.missing.join(", ")}.` : "") + ` ${privacy}`;
}
