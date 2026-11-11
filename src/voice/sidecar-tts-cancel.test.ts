// The voice sidecar's speech queue, run in its own Python (no model, no GPU):
// a reply the user talks over must not silence the replies after it.
// 2026-11-11: a cancel left the streamer waiting forever on a sentence it had
// already taken; every later reply was queued and never spoken, the app heard
// "0 ms" of each, and the user's next words replaced it unheard.
import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { userInfo } from "node:os";
import { join } from "node:path";
import { PYTHON_EXE } from "../routes/bridges/voice-setup/tiers.js";

// The Lite tier's interpreter (tiers.ts), found from the account's real home:
// the test setup points HOME at a throwaway dir so no test reads user data, and
// this reads none, it only runs the installed Python. Skipped where none is.
const python = join(userInfo().homedir, ".lax", "python-voice", "venv", PYTHON_EXE);
const check = join(process.cwd(), "python", "voice", "tests", "check_tts_cancel.py");

describe("voice sidecar speech queue", () => {
  it.skipIf(!existsSync(python))("speaks the reply after one the user cut off", () => {
    const out = execFileSync(python, ["-I", check], { encoding: "utf8", timeout: 60_000 });
    expect(out).toMatch(/next reply audio chunks: [1-9]/);
  });
});
