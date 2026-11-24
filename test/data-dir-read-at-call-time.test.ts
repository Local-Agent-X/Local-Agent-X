// Modules that used to work out their path under the data dir once, at import.
// Each is imported here BEFORE the data dir is set, then asked to read or write:
// the file must land in the data dir in force at the call. A module that goes
// back to a module-level `join(getLaxDir(), ...)` fails its row.
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadPrefs, savePrefs } from "../src/protocols/preferences.js";
import { loadVariables, saveVariables } from "../src/protocols/variables.js";
import { runsDir } from "../src/agent-store/paths.js";
import { tracesDir } from "../src/agents/run-trace.js";
import { appDir, auditDir } from "../src/app-runtime/paths.js";
import { profileStorePath } from "../src/autonomy/profile-store.js";
import { rollbackDirPath } from "../src/autonomy/rollback.js";
import { voiceDir, whisperModel } from "../src/voice/paths.js";
import { sharedBrowserUserDataDir } from "../src/browser/launcher.js";
import { compressedDir } from "../src/memory/cognitive/compression/constants.js";
import { stateFile } from "../src/orchestrator/types.js";
import { logRetry } from "../src/retry-telemetry.js";
import { getModelPaths } from "../src/voice/stt-model-fetch.js";
import { getTTSModelPaths } from "../src/voice/tts-model-fetch.js";
import { getVadModelPaths } from "../src/voice/vad-model-fetch.js";
import { getTier4CacheDir } from "../src/voice/tier4/voice-clone-loader.js";

describe("paths under the data dir are read at call time", () => {
  const before = process.env.LAX_DATA_DIR;
  let dataDir: string;

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), "lax-data-dir-call-time-"));
    process.env.LAX_DATA_DIR = dataDir;
  });
  afterEach(() => {
    if (before === undefined) delete process.env.LAX_DATA_DIR;
    else process.env.LAX_DATA_DIR = before;
    rmSync(dataDir, { recursive: true, force: true });
  });

  it("protocol variables are saved into, and read from, the current data dir", () => {
    saveVariables({ ...loadVariables(), probe: "here" } as ReturnType<typeof loadVariables>);
    expect(existsSync(join(dataDir, "protocol-variables.json"))).toBe(true);
    expect((loadVariables() as Record<string, unknown>).probe).toBe("here");
  });

  it("protocol preferences are saved into the current data dir", () => {
    savePrefs(loadPrefs());
    expect(existsSync(join(dataDir, "protocol-prefs", "prefs.json"))).toBe(true);
  });

  it("retry telemetry is written under each data dir in turn, creating its folder again", () => {
    logRetry({ kind: "custom" });
    expect(existsSync(join(dataDir, "telemetry", "retries.jsonl"))).toBe(true);

    const second = mkdtempSync(join(tmpdir(), "lax-data-dir-call-time-second-"));
    process.env.LAX_DATA_DIR = second;
    try {
      logRetry({ kind: "custom" });
      expect(existsSync(join(second, "telemetry", "retries.jsonl"))).toBe(true);
    } finally {
      rmSync(second, { recursive: true, force: true });
    }
  });

  it("the exported path helpers answer for the current data dir", () => {
    expect(appDir("probe")).toBe(join(dataDir, "apps", "probe"));
    expect(auditDir()).toBe(join(dataDir, "apps", "_audit"));
    expect(tracesDir()).toBe(join(dataDir, "run-traces"));
    expect(runsDir()).toBe(join(dataDir, "agent-runs"));
    expect(sharedBrowserUserDataDir()).toBe(join(dataDir, "chrome-profile"));
    expect(compressedDir()).toBe(join(dataDir, "memory-compressed"));
    expect(stateFile()).toBe(join(dataDir, "orchestrator-state.json"));
    expect(voiceDir()).toBe(join(dataDir, "workspace", "voice-chat"));
    expect(whisperModel().startsWith(voiceDir())).toBe(true);
    expect(profileStorePath()).toBe(join(dataDir, "autonomy-profile.json"));
    expect(rollbackDirPath()).toBe(join(dataDir, "rollback"));
  });

  it("the voice model folders are under the current data dir", () => {
    const under = (p: string): boolean => p.startsWith(join(dataDir, "models"));
    expect(Object.values(getModelPaths()).every((p) => typeof p !== "string" || under(p))).toBe(true);
    expect(Object.values(getTTSModelPaths()).every((p) => typeof p !== "string" || under(p))).toBe(true);
    expect(under(getVadModelPaths().modelDir)).toBe(true);
    expect(getTier4CacheDir()).toBe(join(dataDir, "models", "tts", "kokoro-onnx"));
  });
});
