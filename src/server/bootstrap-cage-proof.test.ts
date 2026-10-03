// Boot proves the Windows shell cage, and each time a proof lands it starts
// the sandbox user's grants over in the background (so no spawn has to make
// them on the event loop) and re-broadcasts the sandbox status.
import { beforeEach, describe, expect, it, vi } from "vitest";

const seam = vi.hoisted(() => ({
  onSettled: null as null | (() => void),
  mode: "host" as "host" | "guarded",
  events: [] as string[],
}));
vi.mock("../sandbox/index.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../sandbox/index.js")>()),
  startSandboxProof: (onSettled: () => void) => { seam.onSettled = onSettled; },
  getSandboxStatus: () => ({ effectiveMode: seam.mode }),
}));
vi.mock("../sandbox/win-cage-grants.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../sandbox/win-cage-grants.js")>()),
  restartWinCageGrants: (cageInUse: boolean) => { seam.events.push(`grants:${cageInUse}`); },
}));
vi.mock("../chat-ws/index.js", () => ({
  broadcastAll: (event: { type: string; settings: { sandbox: { effectiveMode: string } } }) => {
    seam.events.push(`${event.type}:${event.settings.sandbox.effectiveMode}`);
  },
}));

import { startWindowsCageProof } from "./bootstrap-services.js";

beforeEach(() => {
  seam.onSettled = null;
  seam.events = [];
});

describe("startWindowsCageProof", () => {
  it("a proof that lands with the cage in use starts the grants over and grants, then re-broadcasts", async () => {
    await startWindowsCageProof();
    seam.mode = "guarded";
    seam.onSettled!();
    expect(seam.events).toEqual(["grants:true", "settings_changed:guarded"]);
  });

  it("a proof that leaves the cage out of use starts the grants over without granting", async () => {
    await startWindowsCageProof();
    seam.mode = "host";
    seam.onSettled!();
    expect(seam.events).toEqual(["grants:false", "settings_changed:host"]);
  });
});
