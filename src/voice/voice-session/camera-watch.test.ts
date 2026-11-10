import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  WATCH_CHECK_EVERY_MS, WATCH_DEFAULT_MINUTES, WATCH_FRAMES_LOST_MS, WATCH_MAX_MINUTES,
  cameraWatchFor, clampWatchMinutes, createCameraWatch, registerCameraWatch, unregisterCameraWatch,
  type WatchVerdict,
} from "./camera-watch.js";

// "Tell me when the water boils": a watch checks the camera's frames on the side and
// speaks up by itself. These pin its lifecycle: how often it checks, what ends it, and
// what the user hears (or sees in the chat) when it ends.

const FRAME = "data:image/jpeg;base64,/9j/AAAA";

function harness(answers: Array<WatchVerdict | null> = []) {
  const said: string[] = [];
  const noted: string[] = [];
  const checked: Array<{ frame: string; condition: string }> = [];
  const check = vi.fn(async (frame: string, condition: string) => {
    checked.push({ frame, condition });
    return answers.length > 0 ? answers.shift()! : { seen: false, line: "" };
  });
  const watch = createCameraWatch({ say: (t) => said.push(t), note: (t) => noted.push(t), check });
  return { watch, said, noted, checked, check };
}

/** Let the check's promise settle. */
async function settle(): Promise<void> {
  for (let i = 0; i < 5; i++) await Promise.resolve();
}

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); });

describe("camera watch: starting", () => {
  it("needs the camera open and something to watch for", () => {
    const h = harness();
    expect(h.watch.start("the water is boiling")).toMatchObject({ ok: false });
    h.watch.onFrame(FRAME);
    expect(h.watch.start("  ")).toMatchObject({ ok: false });
    expect(h.watch.start("the water is boiling")).toMatchObject({ ok: true, minutes: WATCH_DEFAULT_MINUTES });
  });

  it("does not take a frame that has gone stale as an open camera", () => {
    const h = harness();
    h.watch.onFrame(FRAME);
    vi.advanceTimersByTime(15_000);
    expect(h.watch.start("the water is boiling")).toMatchObject({ ok: false });
  });

  it("keeps the time asked within bounds", () => {
    expect(clampWatchMinutes(undefined)).toBe(WATCH_DEFAULT_MINUTES);
    expect(clampWatchMinutes(-3)).toBe(WATCH_DEFAULT_MINUTES);
    expect(clampWatchMinutes(0.2)).toBe(1);
    expect(clampWatchMinutes(500)).toBe(WATCH_MAX_MINUTES);
  });

  it("a new watch replaces the running one, which ends without a word", () => {
    const h = harness();
    h.watch.onFrame(FRAME);
    h.watch.start("the water is boiling");
    expect(h.watch.start("the cat is back")).toMatchObject({ ok: true, replaced: "the water is boiling" });
    expect(h.said).toEqual([]);
    expect(h.watch.status()).toMatch(/Watching for the cat is back/);
  });
});

describe("camera watch: checking", () => {
  it("checks at once, then no more than once per interval however many frames come", async () => {
    const h = harness();
    h.watch.onFrame(FRAME);
    h.watch.start("the water is boiling");
    await settle();
    expect(h.check).toHaveBeenCalledTimes(1);
    expect(h.checked[0]).toEqual({ frame: FRAME, condition: "the water is boiling" });

    for (let t = 0; t < 3; t++) {
      vi.advanceTimersByTime(2_500);
      h.watch.onFrame(FRAME);
      await settle();
    }
    expect(h.check).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(WATCH_CHECK_EVERY_MS - 7_500);
    h.watch.onFrame(FRAME);
    await settle();
    expect(h.check).toHaveBeenCalledTimes(2);
  });

  it("never runs two checks at once", async () => {
    const h = harness();
    let release: (v: WatchVerdict) => void = () => {};
    h.check.mockImplementationOnce(() => new Promise<WatchVerdict>((r) => { release = r; }));
    h.watch.onFrame(FRAME);
    h.watch.start("the water is boiling");
    vi.advanceTimersByTime(WATCH_CHECK_EVERY_MS * 2);
    h.watch.onFrame(FRAME);
    await settle();
    expect(h.check).toHaveBeenCalledTimes(1);
    release({ seen: false, line: "" });
    await settle();
    expect(h.check).toHaveBeenCalledTimes(2);
  });

  it("when it sees it and the next frame agrees, says the check's line and stops watching", async () => {
    const yes = { seen: true, line: "The water's boiling now." };
    const h = harness([{ seen: false, line: "" }, yes, yes]);
    h.watch.onFrame(FRAME);
    h.watch.start("the water is boiling");
    await settle();
    // The interval's check (on the heartbeat) sees it once: not said yet.
    vi.advanceTimersByTime(WATCH_CHECK_EVERY_MS);
    await settle();
    expect(h.check).toHaveBeenCalledTimes(2);
    expect(h.said).toEqual([]);
    // The confirming check runs on the very next frame, not a full interval later.
    vi.advanceTimersByTime(2_500);
    h.watch.onFrame(FRAME);
    await settle();
    expect(h.check).toHaveBeenCalledTimes(3);
    expect(h.said).toEqual(["The water's boiling now."]);
    expect(h.watch.status()).toMatch(/^Not watching\. The last watch saw it: The water's boiling now\./);

    vi.advanceTimersByTime(WATCH_CHECK_EVERY_MS);
    h.watch.onFrame(FRAME);
    await settle();
    expect(h.check).toHaveBeenCalledTimes(3);
  });

  it("a sighting the next frame does not confirm is not said, and the watch goes on", async () => {
    const h = harness([{ seen: true, line: "It's boiling." }, { seen: false, line: "" }]);
    h.watch.onFrame(FRAME);
    h.watch.start("the water is boiling");
    await settle();
    h.watch.onFrame(FRAME);
    await settle();
    expect(h.check).toHaveBeenCalledTimes(2);
    expect(h.said).toEqual([]);
    expect(h.watch.status()).toMatch(/^Watching for/);
    // Back to the normal pace: the next frame is not checked at once.
    h.watch.onFrame(FRAME);
    await settle();
    expect(h.check).toHaveBeenCalledTimes(2);
  });

  it("confirms on a new frame, never the one that was already checked", async () => {
    const h = harness([{ seen: true, line: "It's boiling." }]);
    h.watch.onFrame(FRAME);
    h.watch.start("the water is boiling");
    await settle();
    vi.advanceTimersByTime(4_000);
    await settle();
    expect(h.check).toHaveBeenCalledTimes(1);
  });

  it("a sighting with no line still says what it saw", async () => {
    const h = harness([{ seen: true, line: "" }, { seen: true, line: "" }]);
    h.watch.onFrame(FRAME);
    h.watch.start("the water is boiling");
    await settle();
    h.watch.onFrame(FRAME);
    await settle();
    expect(h.said).toEqual(["Heads up: the water is boiling."]);
  });

  it("gives up, and says so, when the model stops answering", async () => {
    const h = harness([null, null, null]);
    // (Failed checks keep the normal pace.)
    h.watch.onFrame(FRAME);
    h.watch.start("the water is boiling");
    for (let i = 0; i < 3; i++) {
      await settle();
      vi.advanceTimersByTime(WATCH_CHECK_EVERY_MS);
      h.watch.onFrame(FRAME);
    }
    await settle();
    expect(h.said).toEqual(["I can't check the camera right now, so I've stopped watching for the water is boiling."]);
  });

  it("an answer that comes after the watch ended is dropped", async () => {
    const h = harness();
    let release: (v: WatchVerdict) => void = () => {};
    h.check.mockImplementationOnce(() => new Promise<WatchVerdict>((r) => { release = r; }));
    h.watch.onFrame(FRAME);
    h.watch.start("the water is boiling");
    expect(h.watch.cancel()).toBe("the water is boiling");
    release({ seen: true, line: "The water's boiling now." });
    await settle();
    expect(h.said).toEqual([]);
  });
});

describe("camera watch: what ends it", () => {
  it("the camera closing, said out loud", () => {
    const h = harness();
    h.watch.onFrame(FRAME);
    h.watch.start("the water is boiling");
    h.watch.onFrame(null);
    expect(h.said).toEqual(["The camera closed, so I've stopped watching for the water is boiling."]);
  });

  it("the frames stopping without the camera closing, said out loud", async () => {
    const h = harness();
    h.watch.onFrame(FRAME);
    h.watch.start("the water is boiling");
    await settle();
    vi.advanceTimersByTime(WATCH_FRAMES_LOST_MS + 5_000);
    expect(h.said).toEqual(["I've stopped getting pictures from the camera, so I've stopped watching for the water is boiling."]);
  });

  it("its time running out, said out loud", async () => {
    const h = harness();
    h.watch.onFrame(FRAME);
    h.watch.start("the water is boiling", 2);
    // Frames keep coming the whole time, so only the deadline can end it.
    for (let t = 0; t < (2 * 60_000) / 2_500; t++) {
      vi.advanceTimersByTime(2_500);
      h.watch.onFrame(FRAME);
      await settle();
    }
    expect(h.said).toEqual(["I watched for 2 minutes and didn't see the water is boiling, so I've stopped watching."]);
  });

  it("the user cancelling: quiet, the agent's reply says it", () => {
    const h = harness();
    h.watch.onFrame(FRAME);
    h.watch.start("the water is boiling");
    expect(h.watch.cancel()).toBe("the water is boiling");
    expect(h.watch.cancel()).toBeNull();
    expect(h.said).toEqual([]);
    expect(h.watch.status()).toMatch(/cancelled by the user/);
  });

  it("the call ending: noted in the chat, since nothing can be said", () => {
    const h = harness();
    h.watch.onFrame(FRAME);
    h.watch.start("the water is boiling");
    h.watch.close();
    expect(h.said).toEqual([]);
    expect(h.noted).toEqual(["I stopped watching for the water is boiling: the call ended."]);
    expect(h.watch.start("the cat is back")).toMatchObject({ ok: false });
  });

  it("the call ending with no watch running notes nothing", () => {
    const h = harness();
    h.watch.close();
    expect(h.noted).toEqual([]);
  });
});

describe("camera watch: what the phone is told", () => {
  it("what it watches for when it starts, and null whenever it ends", async () => {
    const changes: Array<string | null> = [];
    const watch = createCameraWatch({ say: () => {}, check: async () => ({ seen: false, line: "" }), onChange: (w) => changes.push(w) });
    watch.onFrame(FRAME);
    watch.start("the water is boiling");
    watch.start("the cat is back");
    watch.cancel();
    watch.start("the oven light is off");
    watch.onFrame(null);
    expect(changes).toEqual(["the water is boiling", null, "the cat is back", null, "the oven light is off", null]);
  });
});

describe("camera watch registry", () => {
  it("finds a call's watch by session id, and forgets it only for that watch", () => {
    const a = harness().watch;
    const b = harness().watch;
    registerCameraWatch("sess-1", a);
    registerCameraWatch("sess-1", b);
    unregisterCameraWatch("sess-1", a);
    expect(cameraWatchFor("sess-1")).toBe(b);
    unregisterCameraWatch("sess-1", b);
    expect(cameraWatchFor("sess-1")).toBeUndefined();
  });
});
