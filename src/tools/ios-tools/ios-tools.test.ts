// The ios tool says what this machine can do with an iPhone instead of
// failing deep in a spawn (Apple's Simulator and UI automation are macOS-only),
// and reads the iOS tools' own output. The Mac half is not run here: it is
// exercised through these parsers and through fakes until it runs on a Mac.
import { describe, it, expect, vi, beforeEach } from "vitest";

const fake = vi.hoisted(() => ({ isMac: false, target: null as null | Record<string, unknown>, calls: [] as string[] }));
vi.mock("../../ios/index.js", async (importOriginal) => {
  const real = await importOriginal<typeof import("../../ios/index.js")>();
  return {
    ...real,
    get IS_MAC() { return fake.isMac; },
    listIosTargets: async () => ({ targets: fake.target ? [fake.target] : [], missing: [] }),
    resolveIosTarget: async () => { if (!fake.target) throw new Error("No iPhone on USB."); return fake.target; },
    simulatorTap: async (_u: string, x: number, y: number) => { fake.calls.push(`tap ${x},${y}`); },
    usbIphoneApps: async () => ["app.labelcheck", "com.apple.camera"],
  };
});

import { createIosTools } from "./index.js";
import { parseSimulatorList, parseUsbmuxList } from "../../ios/index.js";

const [tool] = createIosTools();
const run = (args: Record<string, unknown>) => tool.execute(args, new AbortController().signal);
const sim = { kind: "simulator", udid: "SIM-1", name: "iPhone 16", os: "iOS 18.1", booted: true };
const phone = { kind: "iphone", udid: "00008130-AA", name: "Test iPhone", os: "iOS 18.1", model: "iPhone16,2" };

beforeEach(() => { fake.isMac = false; fake.target = null; fake.calls = []; });

describe("ios tool, off a Mac", () => {
  it.each(["boot_simulator", "tap", "type_text", "install_app", "launch_app", "open_url"])("%s says it needs a Mac", async (action) => {
    const r = await run({ action, x: 1, y: 1 });
    expect(r.isError).toBe(true);
    expect(r.content).toContain("This needs a Mac");
  });

  it("list_devices still lists a USB iPhone, and says what needs a Mac", async () => {
    fake.target = phone;
    const r = await run({ action: "list_devices" });
    expect(r.content).toContain("iPhone Test iPhone (iOS 18.1, 00008130-AA), iPhone16,2");
    expect(r.content).toContain("This needs a Mac");
  });

  it("list_apps answers for one app on the iPhone", async () => {
    fake.target = phone;
    expect((await run({ action: "list_apps", bundle_id: "app.labelcheck" })).content).toBe("app.labelcheck is installed on Test iPhone.");
  });
});

describe("ios tool, on a Mac", () => {
  it("taps a Simulator", async () => {
    fake.isMac = true; fake.target = sim;
    const r = await run({ action: "tap", x: 120, y: 640 });
    expect(r.isError).toBeFalsy();
    expect(fake.calls).toEqual(["tap 120,640"]);
  });

  it("refuses to tap a real iPhone, and says what to do instead", async () => {
    fake.isMac = true; fake.target = phone;
    const r = await run({ action: "tap", x: 1, y: 1 });
    expect(r.isError).toBe(true);
    expect(r.content).toContain("is a real iPhone");
  });
});

describe("reading the iOS tools' output", () => {
  it("simctl's device list: available ones only, booted first, with the OS from the runtime", () => {
    const json = JSON.stringify({ devices: {
      "com.apple.CoreSimulator.SimRuntime.iOS-18-1": [
        { udid: "A", name: "iPhone 15", state: "Shutdown", isAvailable: true },
        { udid: "B", name: "iPhone 16", state: "Booted", isAvailable: true },
        { udid: "C", name: "iPhone 14", state: "Shutdown", isAvailable: false },
      ],
    } });
    expect(parseSimulatorList(json)).toEqual([
      { udid: "B", name: "iPhone 16", state: "Booted", os: "iOS 18.1" },
      { udid: "A", name: "iPhone 15", state: "Shutdown", os: "iOS 18.1" },
    ]);
  });

  it("pymobiledevice3's usbmux list: USB devices with name, model and OS", () => {
    const json = JSON.stringify([
      { UniqueDeviceID: "00008130-AA", DeviceName: "Test iPhone", ProductType: "iPhone16,2", ProductVersion: "18.1", ConnectionType: "USB" },
      { UniqueDeviceID: "00008130-BB", DeviceName: "Wi-Fi iPhone", ProductType: "iPhone15,3", ProductVersion: "17.5", ConnectionType: "Network" },
    ]);
    expect(parseUsbmuxList(json)).toEqual([{ udid: "00008130-AA", name: "Test iPhone", model: "iPhone16,2", os: "iOS 18.1" }]);
  });
});
