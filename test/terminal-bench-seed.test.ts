import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { admitEndpoint } from "../src/local-runtimes/admission.js";
import { candidateEndpoints, manualRuntimeEntries } from "../src/local-runtimes/endpoints.js";
import { PROFILE_NAMES } from "../src/autonomy/profiles.js";
// @ts-expect-error — plain .mjs eval module, no type declarations
import { DEFAULT_LOCAL_URL, buildSeed, parseModel, writeSeed } from "../eval/terminal-bench/seed.mjs";

describe("terminal-bench seed: Harbor model names", () => {
  it("maps lmstudio/ and local/ to LAX's local provider, keeping the model id whole", () => {
    expect(parseModel("lmstudio/qwen3.6-27b")).toEqual({ provider: "local", model: "qwen3.6-27b" });
    expect(parseModel("local/org/model-q6")).toEqual({ provider: "local", model: "org/model-q6" });
  });

  it("refuses a name without a provider or model, and a provider it does not run yet", () => {
    expect(() => parseModel("qwen3.6-27b")).toThrow(/<provider>\/<model>/);
    expect(() => parseModel("lmstudio/")).toThrow(/<provider>\/<model>/);
    expect(() => parseModel("openai/gpt-6")).toThrow(/not supported yet/);
  });
});

describe("terminal-bench seed: the data dir a task starts from", () => {
  let dir: string | null = null;
  afterEach(() => { if (dir) rmSync(dir, { recursive: true, force: true }); dir = null; });

  it("names the LM Studio endpoint the way the product admits a non-loopback runtime", () => {
    const seed = buildSeed({ modelName: "lmstudio/qwen3.6-27b" });
    const settings = JSON.parse(seed["settings.json"]);
    expect(settings).toMatchObject({ provider: "local", model: "qwen3.6-27b" });
    // The product reads this exact entry back, and its discovery sweep probes
    // the endpoint only because it is named there (no private-range carve-out).
    expect(manualRuntimeEntries(settings)).toEqual([{ kind: "openai-compat", baseUrl: DEFAULT_LOCAL_URL, label: "LM Studio" }]);
    const swept = candidateEndpoints(settings).map((c) => c.endpoint.baseUrl);
    expect(swept).toContain(DEFAULT_LOCAL_URL);
    expect(candidateEndpoints({ provider: "local" }).map((c) => c.endpoint.baseUrl)).not.toContain(DEFAULT_LOCAL_URL);
    expect(admitEndpoint(DEFAULT_LOCAL_URL, new Set()).allowed).toBe(false);
  });

  it("runs Autonomous with unrestricted file access, a profile the product knows", () => {
    const seed = buildSeed({ modelName: "lmstudio/m", localUrl: "http://host.docker.internal:4321/" });
    const profile = JSON.parse(seed["autonomy-profile.json"]).profile;
    expect(PROFILE_NAMES).toContain(profile);
    expect(profile).toBe("Autonomous");
    expect(JSON.parse(seed["security.json"])).toEqual({ fileAccessMode: "unrestricted" });
    expect(JSON.parse(seed["settings.json"]).localRuntimes[0].baseUrl).toBe("http://host.docker.internal:4321");
  });

  it("writes every file under the data dir, nested paths included", () => {
    dir = mkdtempSync(join(tmpdir(), "tb-seed-"));
    const seed = buildSeed({ modelName: "lmstudio/m" });
    writeSeed(dir, seed);
    for (const [rel, content] of Object.entries(seed)) {
      expect(readFileSync(join(dir, rel), "utf8")).toBe(content);
    }
  });
});
