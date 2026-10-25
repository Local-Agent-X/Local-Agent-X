// A CLI build runs the codex or claude CLI on the host with its approvals
// bypassed, which developer_mode alone unlocks. Turning the setting off must
// stop a build already running (its adapter kills the CLI's process tree on
// cancel) and one still queued; builds that run inside the loop's own tool
// checks, and builds already over, are not touched.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Op } from "../ops/types.js";

const previousDataDir = process.env.LAX_DATA_DIR;
const dataDir = mkdtempSync(join(tmpdir(), "lax-cli-gate-"));
process.env.LAX_DATA_DIR = dataDir;

const h = vi.hoisted(() => ({
  ops: [] as Op[],
  opCancel: vi.fn((_opId: string, _actor: string) => ({ ok: true })),
}));
vi.mock("../ops/op-store.js", () => ({ listOps: () => h.ops }));
vi.mock("../canonical-loop/index.js", async (importOriginal) => ({ ...(await importOriginal<typeof import("../canonical-loop/index.js")>()), opCancel: h.opCancel }));

const { cancelCliBuildsIfDeveloperModeOff } = await import("./build-app-cli-gate.js");
const { setSetting } = await import("../settings.js");

function build(id: string, strategy: "cli-subprocess" | "in-canonical-sub-agent", state: string): Op {
  return {
    id, type: "app_build",
    runtimeDescriptor: { kind: "app-build", strategy },
    canonical: { state },
  } as unknown as Op;
}

beforeEach(() => {
  h.ops = [
    build("cli-running", "cli-subprocess", "running"),
    build("cli-queued", "cli-subprocess", "queued"),
    build("cli-done", "cli-subprocess", "succeeded"),
    build("http-running", "in-canonical-sub-agent", "running"),
    { id: "chat", type: "chat", canonical: { state: "running" } } as unknown as Op,
  ];
  h.opCancel.mockClear();
});

afterEach(() => {
  setSetting("developer_mode", false);
  h.opCancel.mockClear();
});

describe("cancelCliBuildsIfDeveloperModeOff", () => {
  it("cancels every CLI build still queued or running, and nothing else", async () => {
    setSetting("developer_mode", false);
    h.opCancel.mockClear();
    expect(await cancelCliBuildsIfDeveloperModeOff()).toEqual(["cli-running", "cli-queued"]);
    expect(h.opCancel.mock.calls.map(([id, actor]) => [id, actor])).toEqual([
      ["cli-running", "developer_mode_off"],
      ["cli-queued", "developer_mode_off"],
    ]);
  });

  it("cancels nothing while developer_mode is on", async () => {
    setSetting("developer_mode", true);
    h.opCancel.mockClear();
    expect(await cancelCliBuildsIfDeveloperModeOff()).toEqual([]);
    expect(h.opCancel).not.toHaveBeenCalled();
  });

  it("the settings seam runs the sweep when the setting flips off, not on every write", async () => {
    setSetting("developer_mode", true);
    h.opCancel.mockClear();
    setSetting("theme", "dark");
    await new Promise((r) => setTimeout(r, 0));
    expect(h.opCancel).not.toHaveBeenCalled();

    setSetting("developer_mode", false);
    await vi.waitFor(() => expect(h.opCancel).toHaveBeenCalledTimes(2));
  });
});

process.on("exit", () => {
  if (previousDataDir === undefined) delete process.env.LAX_DATA_DIR;
  else process.env.LAX_DATA_DIR = previousDataDir;
  rmSync(dataDir, { recursive: true, force: true });
});
