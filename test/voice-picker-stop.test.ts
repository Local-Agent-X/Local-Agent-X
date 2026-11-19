// @vitest-environment happy-dom
//
// A running voice sidecar has a Stop button on the voice card. The sidecars
// hold GPU memory a local chat model needs (VoxCPM alone 5.6 GB), and with
// no way to stop them a 27B chat model paged to system memory (2026-11-18).
import { describe, it, expect, beforeEach, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const js = (f: string) => readFileSync(join(__dirname, "../public/js", f), "utf8");
const source = [js("voice-picker-catalog.js"), js("voice-picker.js"), js("voice-picker-prereqs.js")].join("\n");

interface Picker {
  row: (p: { kind: string; label: string }, idx: number, tierId: string) => string;
  act: (tierId: string, action: string, target: string, btn: HTMLButtonElement) => Promise<void>;
  setStatus: (s: unknown) => void;
}

let picker: Picker;
let posts: Array<{ path: string; body: unknown }>;
beforeEach(() => {
  posts = [];
  const apiPost = vi.fn(async (path: string, body: unknown) => { posts.push({ path, body }); return { ok: true }; });
  picker = new Function("apiPost", `${source}
    _refreshSetupStatus = async () => {};
    _refreshSecretNames = async () => {};
    _renderTierStatus = () => {};
    return {
      row: _renderPrereqRow,
      act: onTierPrereqAction,
      setStatus: (s) => { _setupStatus = s; },
    };`)(apiPost) as Picker;
});

const vox = { kind: "sidecar:studio-vox", label: "VoxCPM sidecar" };

describe("Stop on a running voice sidecar", () => {
  it("shows Stop beside Repair while it runs, and Start (no Stop) once it is down", () => {
    picker.setStatus({ tiers: [{ id: "studio-vox", installed: true, healthy: true }] });
    const running = picker.row(vox, 1, "studio");
    expect(running).toContain("'stop-sidecar','studio-vox'");
    expect(running).toContain(">Stop</button>");

    picker.setStatus({ tiers: [{ id: "studio-vox", installed: true, healthy: false }] });
    const stopped = picker.row(vox, 1, "studio");
    expect(stopped).not.toContain("stop-sidecar");
    expect(stopped).toContain("'start-sidecar','studio-vox'");
  });

  it("asks the server to stop that sidecar", async () => {
    vi.useFakeTimers();
    const btn = document.createElement("button");
    const done = picker.act("studio", "stop-sidecar", "studio-vox", btn);
    await vi.runAllTimersAsync();
    await done;
    vi.useRealTimers();
    expect(posts).toEqual([{ path: "/api/voices/setup/stop", body: { tier: "studio-vox" } }]);
  });
});
