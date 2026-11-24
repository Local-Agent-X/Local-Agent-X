// The phone gate reads the device's own log (device-check.ts). On 2026-11-23 a
// build was called tested on the phone after an install and a launch; its core
// flow failed and nothing said where. These pin what counts as evidence.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const adb = vi.hoisted(() => ({ log: "", installed: ["app.labelcheck"], fail: "" }));
const ios = vi.hoisted(() => ({ kind: "simulator" as "simulator" | "iphone", log: "", installed: true }));
vi.mock("../ios/index.js", () => ({
  resolveIosTarget: async () => ios.kind === "simulator"
    ? { kind: "simulator", udid: "SIM-1", name: "iPhone 16", os: "iOS 18.1", booted: true }
    : { kind: "iphone", udid: "00008130-AA", name: "Test iPhone", os: "iOS 18.1", model: "iPhone16,2" },
  simulatorHasApp: async () => ios.installed,
  simulatorLog: async () => ios.log,
  usbIphoneApps: async () => (ios.installed ? ["app.labelcheck"] : []),
}));
vi.mock("../android/index.js", () => ({
  resolveSerial: async (s?: string) => { if (adb.fail) throw new Error(adb.fail); return s ?? "R5CX123"; },
  deviceInfo: async () => ({ model: "SM-S948U1", android: "16" }),
  listApps: async () => adb.installed.map((packageName) => ({ packageName })),
  dumpLog: async () => adb.log,
}));

import { analyzeDeviceLog, deviceLedgerLine, readDeviceSpec, type DeviceSpec } from "./device-check.js";
import { deviceCheckTool } from "./device-check-tool.js";

const SPEC: DeviceSpec = { package: "app.labelcheck", tag: "LabelCheck", stages: ["photo", "ocr", "extract", "result"], private: ["Testamycin"] };
// threadtime lines, as `adb logcat -d -v threadtime` prints them.
const js = (t: string, msg: string) => `11-23 22:10:${t}  4412  4500 I ReactNativeJS: ${msg}`;
const native = (t: string, msg: string) => `11-23 22:10:${t}  4412  4471 I LabelCheck: ${msg}`;
const other = (t: string, msg: string) => `11-23 22:10:${t}  1201  1201 D ActivityManager: ${msg}`;

const fullRun = [
  js("01.000", "LabelCheck stage=photo where=device"),
  native("01.300", "stage=ocr where=device ms=280"),
  js("05.400", "LabelCheck stage=extract where=device ms=4100"),
  js("05.600", "LabelCheck stage=result"),
];

describe("reading the device log", () => {
  it("finds every stage of the latest run, JS lines and native-tag lines alike, with where and how long", () => {
    const r = analyzeDeviceLog([other("00.500", "start app.labelcheck"), ...fullRun].join("\n"), SPEC);
    expect(r.missing).toEqual([]);
    expect(r.run.map((s) => [s.stage, s.where, s.ms])).toEqual([
      ["photo", "device", undefined], ["ocr", "device", 280], ["extract", "device", 4100], ["result", undefined, undefined],
    ]);
  });

  it("judges the LATEST run: an earlier complete run does not cover a later broken one", () => {
    const broken = [js("09.000", "LabelCheck stage=photo"), native("09.300", "stage=ocr")];
    const r = analyzeDeviceLog([...fullRun, ...broken].join("\n"), SPEC);
    expect(r.run.map((s) => s.stage)).toEqual(["photo", "ocr"]);
    expect(r.missing).toEqual(["extract", "result"]);
  });

  it("an app that logs no stages has no run at all", () => {
    const r = analyzeDeviceLog([other("01.000", "start app.labelcheck"), js("02.000", "Reading label…")].join("\n"), SPEC);
    expect(r.run).toEqual([]);
    expect(r.missing).toEqual(SPEC.stages);
  });

  it("another app's tag that merely contains the word does not count", () => {
    const r = analyzeDeviceLog(js("01.000", "NotLabelCheck stage=photo"), SPEC);
    expect(r.run).toEqual([]);
  });

  it("finds a test value anywhere in the log, under any tag, any case", () => {
    const r = analyzeDeviceLog([...fullRun, other("06.000", "saved med TESTAMYCIN 500mg"), js("06.100", "meds: testamycin")].join("\n"), SPEC);
    expect(r.leaks).toEqual([{ index: 0, lines: 2, tags: ["ActivityManager", "ReactNativeJS"] }]);
  });
});

describe("the ledger line", () => {
  const facts = (log: string, installed = true) => ({
    date: "2026-11-24", device: { serial: "R5CX123", model: "SM-S948U1", os: "Android 16" }, spec: SPEC, installed, report: analyzeDeviceLog(log, SPEC),
  });

  it("PASS names the device, each stage with where and time, the span and the privacy search", () => {
    const line = deviceLedgerLine(facts(fullRun.join("\n")));
    expect(line).toContain("PASS on SM-S948U1, Android 16 (R5CX123), app app.labelcheck.");
    expect(line).toContain("photo (device) → ocr (device, 280 ms) → extract (device, 4100 ms) → result, 4.6 s first to last.");
    expect(line).toContain("Searched 4 log lines for 1 test value: none found.");
  });

  it("FAIL on a leak, and the test value itself is never written to the ledger", () => {
    const line = deviceLedgerLine(facts([...fullRun, other("06.000", "Testamycin")].join("\n")));
    expect(line).toContain("FAIL");
    expect(line).toContain("LEAK: test value 1 on 1 line (log tag ActivityManager).");
    expect(line.toLowerCase()).not.toContain("testamycin");
  });

  it("FAIL when the app is not installed, even with a clean log", () => {
    expect(deviceLedgerLine(facts(fullRun.join("\n"), false))).toMatch(/FAIL .* NOT INSTALLED/);
  });
});

describe("the project's .lax-device.json", () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "lax-device-spec-")); });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));
  const write = (v: unknown) => writeFileSync(join(dir, ".lax-device.json"), JSON.stringify(v));

  it("must say what is private: a missing list is an error, an empty one is an answer", () => {
    write({ package: "a.b", tag: "T", stages: ["s"] });
    expect(readDeviceSpec(dir)).toEqual({ error: expect.stringContaining("`private`") });
    write({ package: "a.b", tag: "T", stages: ["s"], private: [] });
    expect(readDeviceSpec(dir)).toEqual({ package: "a.b", tag: "T", stages: ["s"], private: [] });
  });

  it("names everything missing at once, and a tag that could not be matched safely", () => {
    write({ tag: "has space" });
    const r = readDeviceSpec(dir) as { error: string };
    expect(r.error).toContain("`package`");
    expect(r.error).toContain("`tag`");
    expect(r.error).toContain("`stages`");
  });
});

describe("device_check, end to end with adb faked", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "lax-device-check-"));
    writeFileSync(join(dir, ".lax-device.json"), JSON.stringify(SPEC));
    adb.log = fullRun.join("\n"); adb.installed = ["app.labelcheck"]; adb.fail = "";
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));
  const run = () => deviceCheckTool.execute({ project_dir: dir }, new AbortController().signal);

  it("PASS is written to the ledger by the tool, starting the ledger when there is none", async () => {
    const r = await run();
    expect(r.isError).toBeFalsy();
    expect(r.content).toMatch(/^2\d{3}-\d\d-\d\d device check \(device_check, run by LAX\): PASS/);
    expect(readFileSync(join(dir, "spec", "ledger.md"), "utf8")).toMatch(/# Ledger\n\n- .* PASS on SM-S948U1/);
  });

  it("appends to an existing ledger without touching what is there", async () => {
    mkdirSync(join(dir, "spec"));
    writeFileSync(join(dir, "spec", "ledger.md"), "# Ledger — Label Check\n\n- earlier entry\n");
    await run();
    const ledger = readFileSync(join(dir, "spec", "ledger.md"), "utf8");
    expect(ledger.startsWith("# Ledger — Label Check\n\n- earlier entry\n")).toBe(true);
    expect(ledger).toContain("PASS");
  });

  it("a broken run says where the flow stopped, and names the leaked value to the agent only", async () => {
    adb.log = [js("01.000", "LabelCheck stage=photo"), native("01.300", "stage=ocr"), other("02.000", "Testamycin")].join("\n");
    const r = await run();
    expect(r.content).toContain("FAIL");
    expect(r.content).toContain("The latest run stopped before: extract, result.");
    expect(r.content).toContain('"Testamycin" reached the log');
    expect(readFileSync(join(dir, "spec", "ledger.md"), "utf8")).not.toContain("Testamycin");
  });

  it("no stage logged at all asks for the flow to be run, or for the app to log its stages", async () => {
    adb.log = other("01.000", "start app.labelcheck");
    const r = await run();
    expect(r.content).toContain("No line logged `LabelCheck stage=photo`");
  });

  it("no device, or no spec, is an error and writes nothing", async () => {
    adb.fail = "No Android device/emulator is connected.";
    expect((await run()).isError).toBe(true);
    rmSync(join(dir, ".lax-device.json"));
    const r = await run();
    expect(r.isError).toBe(true);
    expect(r.content).toContain("has no .lax-device.json");
  });
});

// iOS: the Simulator's `log show --style syslog`, and a syslog captured from a
// real iPhone with pymobiledevice3, which keeps no log to read back.
const simLine = (t: string, proc: string, msg: string) => `2026-11-24 00:10:${t}123-0600  localhost ${proc}[4412]: ${msg}`;
const phoneLine = (t: string, proc: string, msg: string) => `2026-11-24 00:10:${t}456 ${proc}[4412] <Notice>: ${msg}`;

describe("reading an iOS log", () => {
  it("finds the stages in a Simulator log, JS lines (with their category) and native-tag lines alike", () => {
    const log = [
      simLine("01.", "LabelCheck", "(ReactNativeJS) LabelCheck stage=photo where=device"),
      simLine("01.", "LabelCheck", "stage=ocr where=device ms=280"),
      simLine("05.", "LabelCheck", "LabelCheck stage=extract where=device ms=4100"),
      simLine("05.", "SpringBoard", "unrelated"),
      simLine("06.", "LabelCheck", "LabelCheck stage=result"),
    ].join("\n");
    const r = analyzeDeviceLog(log, SPEC);
    expect(r.missing).toEqual([]);
    expect(r.run.map((s) => [s.stage, s.where, s.ms])).toEqual([
      ["photo", "device", undefined], ["ocr", "device", 280], ["extract", "device", 4100], ["result", undefined, undefined],
    ]);
  });

  it("reads an iPhone syslog capture, and names the process a leaked value was logged by", () => {
    const log = [phoneLine("01.", "LabelCheck", "LabelCheck stage=photo"), phoneLine("02.", "mediaserverd", "saved Testamycin")].join("\n");
    const r = analyzeDeviceLog(log, SPEC);
    expect(r.run.map((s) => s.stage)).toEqual(["photo"]);
    expect(r.leaks).toEqual([{ index: 0, lines: 1, tags: ["mediaserverd"] }]);
  });
});

describe("device_check on iOS, with the device faked", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "lax-device-check-ios-"));
    writeFileSync(join(dir, ".lax-device.json"), JSON.stringify(SPEC));
    ios.kind = "simulator"; ios.installed = true;
    ios.log = ["photo", "ocr", "extract", "result"].map((s, i) => simLine(`0${i}.`, "LabelCheck", `LabelCheck stage=${s}`)).join("\n");
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));
  const run = (extra: Record<string, unknown> = {}) => deviceCheckTool.execute({ project_dir: dir, platform: "ios", ...extra }, new AbortController().signal);

  it("PASS on a Simulator reads its own log and names it in the ledger", async () => {
    const r = await run();
    expect(r.content).toContain("PASS on iPhone 16 Simulator, iOS 18.1 (SIM-1), app app.labelcheck.");
  });

  it("a real iPhone without a captured log says how to capture one, and writes nothing", async () => {
    ios.kind = "iphone";
    const r = await run();
    expect(r.isError).toBe(true);
    expect(r.content).toContain("pymobiledevice3 syslog live");
  });

  it("a real iPhone with a captured log is checked from that file", async () => {
    ios.kind = "iphone";
    const file = join(dir, "phone.log");
    writeFileSync(file, ["photo", "ocr", "extract", "result"].map((s, i) => phoneLine(`0${i}.`, "LabelCheck", `LabelCheck stage=${s}`)).join("\n"));
    const r = await run({ log_file: file });
    expect(r.content).toContain("PASS on Test iPhone (iPhone16,2), iOS 18.1");
  });
});
