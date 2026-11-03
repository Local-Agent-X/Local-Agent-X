import { describe, expect, it } from "vitest";
import { reaperKeepSet } from "./process-control.js";

describe("reaperKeepSet — which of a tier's processes the orphan reaper spares", () => {
  // The Lite tier on Windows after a LAX restart, as captured 2026-11-02: the
  // venv python.exe (38160, matches "python-voice" + "server.py") launched the
  // base interpreter (16776), which holds :7008 but carries no venv path, so the
  // signature sweep finds only the launcher.
  const launcher = { pid: 38160, ppid: 2936 };
  const portOwner = { pid: 16776, ppid: 38160 };

  it("spares the launcher of the healthy worker holding the port", () => {
    expect(reaperKeepSet([launcher], null, portOwner).has(38160)).toBe(true);
  });

  it("still reaps a stale launcher that is not the port owner's parent", () => {
    const stale = { pid: 500, ppid: 1 };
    const keep = reaperKeepSet([launcher, stale], null, portOwner);
    expect(keep.has(500)).toBe(false);
    expect(keep.has(38160)).toBe(true);
  });

  it("spares the owned launcher's worker when both match the signature", () => {
    const worker = { pid: 41, ppid: 40 };
    const keep = reaperKeepSet([{ pid: 40, ppid: 1 }, worker], 40, null);
    expect([...keep].sort()).toEqual([40, 41]);
  });

  it("does not spare an unrelated parent of the listener", () => {
    // A listener spawned directly by the server: its parent is not a sidecar
    // process, so nothing else is kept on its account.
    const keep = reaperKeepSet([{ pid: 77, ppid: 1 }], null, { pid: 16776, ppid: 2936 });
    expect(keep.has(77)).toBe(false);
  });
});
