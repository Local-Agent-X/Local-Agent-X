import { afterEach, describe, expect, it } from "vitest";
import { createCameraWatchTool } from "./camera-watch-tool.js";
import { createCameraWatch, registerCameraWatch, unregisterCameraWatch, type CameraWatch } from "./voice-session/camera-watch.js";

const SID = "chat-thread-1";
let registered: CameraWatch | null = null;

function callWithCamera(): { said: string[] } {
  const said: string[] = [];
  const watch = createCameraWatch({ say: (t) => said.push(t), check: async () => ({ seen: false, line: "" }) });
  watch.onFrame("data:image/jpeg;base64,/9j/AAAA");
  registerCameraWatch(SID, watch);
  registered = watch;
  return { said };
}

afterEach(() => {
  if (registered) {
    registered.close();
    unregisterCameraWatch(SID, registered);
    registered = null;
  }
});

const canSee = { whyCannotSee: async () => null };
const run = (tool: ReturnType<typeof createCameraWatchTool>, args: Record<string, unknown>) =>
  tool.execute({ _sessionId: SID, ...args });

describe("camera_watch tool", () => {
  it("has no call to watch on outside a call", async () => {
    const r = await run(createCameraWatchTool(canSee), { action: "start", condition: "the water is boiling" });
    expect(r.isError).toBe(true);
    expect(r.content).toMatch(/no voice call/i);
  });

  it("starts, reports and stops a watch on the chat's call", async () => {
    callWithCamera();
    const tool = createCameraWatchTool(canSee);
    const started = await run(tool, { action: "start", condition: "the water is boiling", minutes: 5 });
    expect(started.isError).toBeFalsy();
    expect(started.content).toMatch(/Watching the camera for the water is boiling for up to 5 minutes/);
    expect((await run(tool, { action: "status" })).content).toMatch(/^Watching for the water is boiling/);
    expect((await run(tool, { action: "stop" })).content).toBe("Stopped watching for the water is boiling.");
    expect((await run(tool, { action: "stop" })).content).toBe("Nothing was being watched.");
  });

  it("says why when the model the user is on cannot look at pictures", async () => {
    callWithCamera();
    const tool = createCameraWatchTool({ whyCannotSee: async () => "needs a hosted model" });
    const r = await run(tool, { action: "start", condition: "the water is boiling" });
    expect(r).toEqual({ content: "needs a hosted model", isError: true });
  });

  it("passes on the watch's own refusal", async () => {
    callWithCamera();
    const r = await run(createCameraWatchTool(canSee), { action: "start", condition: "" });
    expect(r.isError).toBe(true);
  });
});
