/**
 * The device tools a session gets because of the project it works in. A
 * session whose folder is a phone app (app-scaffold/project-kind.ts
 * mobilePlatforms) gets every tool tagged `device` (driving an emulator or a
 * phone, reading its log) in its tool set, whatever else selected the set:
 * a code session's kit, a chat's per-message picks, a /greenfield build.
 *
 * Without it the build agent of a phone app had no way to touch a device: on
 * 2026-11-23 the `android` tool was in no session's set (its row had no tags),
 * so a label-check build was "tested" by installing it and asking the owner
 * what the screen said, and an edit to an existing app had the same gap.
 */
import { mobilePlatforms } from "../../app-scaffold/project-kind.js";
import { toolsTagged } from "../../tool-registry.js";
import { sessionWorkRootOf } from "../../workspace/paths.js";

/** The device tools' names when the session's folder is a phone app; none
 *  otherwise (no folder yet, or not a phone app). */
export function deviceToolNamesFor(sessionId: string): string[] {
  const dir = sessionWorkRootOf(sessionId);
  if (!dir || mobilePlatforms(dir).length === 0) return [];
  return toolsTagged("device");
}
