// What the user showed the agent on a call, waiting to go with their next words: photos
// and files they attached (the phone's `attach` frame), and the camera's latest frame
// while they have it open (`camera`). Each turn takes what is waiting: the attachments
// once, the camera frame every turn it is open and fresh, so the agent sees what the
// user is pointing it at when they speak.
//
// A turn that continues one the user talked over (turn-runner's continuation merge)
// replaces it, rows and all, so it carries again what that turn carried: without it, a
// photo sent with words the user then interrupted would be gone from the thread.

import type { VoiceAttachment } from "../audio-ws.js";

/** A camera frame older than this is not what the camera shows now: the phone stopped
 *  sending (it went to the background, the link stalled), so the turn goes without. */
export const CAMERA_FRESH_MS = 10_000;

export interface UtteranceMedia {
  /** Photos or files to send with the next turn. */
  attach(attachments: readonly VoiceAttachment[]): void;
  /** The camera's latest frame (a data:image URL), or null: the camera closed. */
  setCameraFrame(frame: string | null): void;
  /** What goes with a turn. `continuing`: it replaces the turn the user talked over. */
  forTurn(continuing: boolean): VoiceAttachment[];
}

function cameraAttachment(dataUrl: string): VoiceAttachment {
  const type = /^data:([^;,]+)/.exec(dataUrl)?.[1] ?? "image/jpeg";
  return { name: "camera.jpg", type, isImage: true, dataUrl, size: 0 };
}

export function createUtteranceMedia(now: () => number = Date.now): UtteranceMedia {
  let pending: VoiceAttachment[] = [];
  let camera: { frame: string; at: number } | null = null;
  let lastTaken: VoiceAttachment[] = [];

  return {
    attach(attachments) {
      pending = [...pending, ...attachments];
    },
    setCameraFrame(frame) {
      camera = frame === null ? null : { frame, at: now() };
    },
    forTurn(continuing) {
      const carried = continuing ? lastTaken.filter((a) => a.name !== "camera.jpg") : [];
      const live = camera !== null && now() - camera.at < CAMERA_FRESH_MS ? [cameraAttachment(camera.frame)] : [];
      const out = [...carried, ...pending, ...live];
      pending = [];
      lastTaken = out;
      return out;
    },
  };
}
