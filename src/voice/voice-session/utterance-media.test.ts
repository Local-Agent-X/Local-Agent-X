// What the user showed the agent on a call goes with their next words: an attachment
// once, the camera's frame with every turn while it is open and fresh, and a turn that
// replaces one the user talked over carries what that turn carried.
import { describe, it, expect } from "vitest";
import { CAMERA_FRESH_MS, createUtteranceMedia } from "./utterance-media.js";

const photo = { name: "a.jpg", type: "image/jpeg", isImage: true, dataUrl: "data:image/jpeg;base64,AAAA", size: 3 };
const FRAME = "data:image/jpeg;base64,BBBB";

describe("utterance media", () => {
  it("sends an attachment with the next turn only", () => {
    const m = createUtteranceMedia();
    m.attach([photo]);
    expect(m.forTurn(false)).toEqual([photo]);
    expect(m.forTurn(false)).toEqual([]);
  });

  it("sends the camera's frame with every turn while it is open, none once closed", () => {
    const m = createUtteranceMedia();
    m.setCameraFrame(FRAME);
    expect(m.forTurn(false).map((a) => a.dataUrl)).toEqual([FRAME]);
    expect(m.forTurn(false).map((a) => a.name)).toEqual(["camera.jpg"]);
    expect(m.forTurn(false).map((a) => a.glance)).toEqual([true]);
    m.setCameraFrame(null);
    expect(m.forTurn(false)).toEqual([]);
  });

  it("leaves out a frame the phone stopped refreshing", () => {
    let t = 0;
    const m = createUtteranceMedia(() => t);
    m.setCameraFrame(FRAME);
    t = CAMERA_FRESH_MS;
    expect(m.forTurn(false)).toEqual([]);
  });

  it("carries the talked-over turn's attachments into the turn that replaces it, with the camera as it is now", () => {
    const m = createUtteranceMedia();
    m.attach([photo]);
    m.setCameraFrame(FRAME);
    m.forTurn(false); // the turn the user then talked over
    m.setCameraFrame("data:image/jpeg;base64,CCCC");
    expect(m.forTurn(true).map((a) => a.dataUrl)).toEqual([photo.dataUrl, "data:image/jpeg;base64,CCCC"]);
  });
});
