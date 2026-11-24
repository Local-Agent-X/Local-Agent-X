/**
 * device_check — the phone half of a mobile build's finish gates (the
 * /greenfield skill, references/gates.md section 1): read the connected
 * phone's log and say whether the latest run of the app's core flow ran there,
 * stage by stage, and whether any test value the owner entered reached the
 * log. The verdict goes into the project's `spec/ledger.md` by the harness
 * itself, so "tested on the phone" in a completion report points at a line
 * nobody wrote by hand.
 *
 * It only reads the device (its log, its properties, its package list). The
 * agent installs the build and drives the flow, or asks the owner to; this
 * tool is what it shows afterwards. What it looks for: device-check.ts.
 */
import { appendFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ToolDefinition, ToolResult } from "../types.js";
import { readAndroidDevice, readIosDevice } from "./device-check-read.js";
import { resolveProjectDir } from "./project-paths.js";
import { analyzeDeviceLog, deviceCheckPassed, deviceLedgerLine, DEVICE_SPEC_FILENAME, readDeviceSpec, type DeviceCheckFacts } from "./device-check.js";

/** Append the verdict to the project's ledger, starting one if it has none. */
function recordInLedger(projectDir: string, line: string): string {
  const spec = join(projectDir, "spec");
  const ledger = join(spec, "ledger.md");
  if (!existsSync(ledger)) {
    mkdirSync(spec, { recursive: true });
    writeFileSync(ledger, "# Ledger\n");
  }
  appendFileSync(ledger, `\n${line}\n`);
  return ledger;
}

/** What to do about a failed check, for the agent. Names the test values
 *  (the agent set them); the ledger does not. */
function nextSteps(f: DeviceCheckFacts): string[] {
  const out: string[] = [];
  if (!f.installed) out.push(`${f.spec.package} is not installed on the device: install the build, run the flow, then check again.`);
  if (f.report.run.length === 0) {
    out.push(`No line logged \`${f.spec.tag} stage=${f.spec.stages[0]}\`: either the flow was not run since the log was last cleared, ` +
      "or the app does not log its stages (the constitution's rule). Run the flow on the phone, or ask the owner to, then check again.");
  } else if (f.report.missing.length) {
    out.push(`The latest run stopped before: ${f.report.missing.join(", ")}. That is where the flow failed or the stage is not logged; read the code at that stage.`);
  }
  for (const l of f.report.leaks) {
    out.push(`"${f.spec.private[l.index]}" reached the log on ${l.lines} line(s), log tag ${l.tags.join(", ")}: find what logs it and stop it.`);
  }
  return out;
}

export const deviceCheckTool: ToolDefinition = {
  name: "device_check",
  compactDescription: "Read the connected phone's log: did the app's core flow run there, stage by stage, and did any test value leak.",
  description:
    "The phone half of a mobile build's finish gates. Reads the connected Android device's or iOS Simulator's log (or a log " +
    "captured from a real iPhone, `log_file`) against the project's " +
    `\`${DEVICE_SPEC_FILENAME}\` (app id, log tag, the core flow's stages, test values that must never be logged) and reports ` +
    "whether the latest run of the flow ran every stage on the device, where each ran and how long it took, and whether any " +
    "test value appears anywhere in the log. Writes the verdict to the project's spec/ledger.md. Install the build and run the " +
    "flow on the phone first (or ask the owner to, saying exactly what to do); this only reads the device.",
  parameters: {
    type: "object",
    properties: {
      project_dir: { type: "string", description: "The project: a bare name (`workspace/apps/<name>`) or its absolute path." },
      platform: { type: "string", enum: ["android", "ios"], description: "Which phone: android (default) or ios." },
      device: { type: "string", description: "The device's adb serial, or the Simulator's / iPhone's udid. Omit when one is connected." },
      log_file: { type: "string", description: "A log captured from the device while the flow ran. Required for a real iPhone, which keeps no log to read back: start `pymobiledevice3 syslog live > <file>` with process_start before the flow." },
    },
    required: ["project_dir"],
  },
  async execute(args): Promise<ToolResult> {
    const projectDir = resolveProjectDir(args.project_dir);
    if (!projectDir) return { content: "device_check needs `project_dir`.", isError: true };
    const spec = readDeviceSpec(projectDir);
    if ("error" in spec) {
      return {
        content: `${spec.error} Write it at the project root: {"package": "<app id>", "tag": "<log tag>", "stages": ["<stage>", ...], ` +
          `"private": ["<a test value entered on the phone>", ...]}, with the app logging each stage as \`<tag> stage=<name>\`.`,
        isError: true,
      };
    }
    let facts: DeviceCheckFacts;
    try {
      const device = typeof args.device === "string" && args.device ? args.device : undefined;
      const logFile = typeof args.log_file === "string" && args.log_file ? args.log_file : undefined;
      const read = args.platform === "ios" ? readIosDevice : readAndroidDevice;
      const reading = await read(spec.package, device, logFile);
      facts = {
        date: new Date().toISOString().slice(0, 10),
        device: reading.device,
        spec,
        installed: reading.installed,
        report: analyzeDeviceLog(reading.log, spec),
      };
    } catch (e) {
      return { content: `Could not read the device: ${(e as Error).message}`, isError: true };
    }
    const line = deviceLedgerLine(facts);
    const ledger = recordInLedger(projectDir, line);
    const passed = deviceCheckPassed(facts);
    const steps = passed ? [] : nextSteps(facts);
    // A FAIL is the check's answer, not a failed call (holdout_judge reports a
    // failing scenario the same way).
    return { content: `${line.slice(2)}\n\nRecorded in ${ledger}.` + (steps.length ? `\n\nNext:\n${steps.map((s) => `- ${s}`).join("\n")}` : "") };
  },
};
