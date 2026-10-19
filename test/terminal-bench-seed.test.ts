import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { admitEndpoint } from "../src/local-runtimes/admission.js";
import { candidateEndpoints, manualRuntimeEntries } from "../src/local-runtimes/endpoints.js";
import { PROFILE_NAMES } from "../src/autonomy/profiles.js";
// @ts-expect-error — plain .mjs eval module, no type declarations
import { DEFAULT_LOCAL_URL, DEFAULT_OLLAMA_URL, SERVER_ENV, buildSeed, parseModel, writeSeed } from "../eval/terminal-bench/seed.mjs";

describe("terminal-bench seed: Harbor model names", () => {
  it("maps lmstudio/, local/ and ollama/ to LAX's local provider, keeping the model id whole", () => {
    expect(parseModel("lmstudio/qwen3.6-27b")).toMatchObject({ provider: "local", model: "qwen3.6-27b", runtime: { kind: "openai-compat" } });
    expect(parseModel("local/org/model-q6")).toMatchObject({ provider: "local", model: "org/model-q6" });
    expect(parseModel("ollama/qwen3.6:27b")).toMatchObject({ provider: "local", model: "qwen3.6:27b", runtime: { kind: "ollama", url: DEFAULT_OLLAMA_URL } });
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

  it("names an Ollama model's runtime as Ollama, which the product then sweeps", () => {
    const settings = JSON.parse(buildSeed({ modelName: "ollama/qwen3.6:27b" })["settings.json"]);
    expect(settings).toMatchObject({ provider: "local", model: "qwen3.6:27b" });
    expect(manualRuntimeEntries(settings)).toEqual([{ kind: "ollama", baseUrl: DEFAULT_OLLAMA_URL, label: "Ollama" }]);
    const ollama = candidateEndpoints(settings).find((c) => c.endpoint.baseUrl === DEFAULT_OLLAMA_URL);
    expect(ollama?.kind).toBe("ollama");
  });

  it("runs Autonomous with unrestricted file access, a profile the product knows", () => {
    const seed = buildSeed({ modelName: "lmstudio/m", localUrl: "http://host.docker.internal:4321/" });
    const profile = JSON.parse(seed["autonomy-profile.json"]).profile;
    expect(PROFILE_NAMES).toContain(profile);
    expect(profile).toBe("Autonomous");
    expect(JSON.parse(seed["security.json"])).toEqual({ fileAccessMode: "unrestricted", disposableSandbox: true });
    expect(JSON.parse(seed["settings.json"]).localRuntimes[0].baseUrl).toBe("http://host.docker.internal:4321");
  });

  it("lets an HTTP-driven turn run shell inside the container, through the product's own acknowledgement", async () => {
    dir = mkdtempSync(join(tmpdir(), "tb-seed-"));
    writeSeed(dir, buildSeed({ modelName: "lmstudio/m" }));
    const saved = { data: process.env.LAX_DATA_DIR, sandbox: process.env.LAX_SANDBOX };
    process.env.LAX_DATA_DIR = dir;
    process.env.LAX_SANDBOX = SERVER_ENV.LAX_SANDBOX;
    try {
      const { getSandboxStatus } = await import("../src/sandbox/index.js");
      const status = getSandboxStatus();
      expect(status.selectedMode).toBe("host");
      expect(status.confined).toBe(false);
      // The gate an "api" chat turn's bash call passes (unattended-shell-gate.ts).
      expect(status.apiShellAllowed).toBe(true);
      rmSync(join(dir, "sandbox-host-acknowledgement.json"));
      expect(getSandboxStatus().apiShellAllowed).toBe(false);
    } finally {
      if (saved.data === undefined) delete process.env.LAX_DATA_DIR; else process.env.LAX_DATA_DIR = saved.data;
      if (saved.sandbox === undefined) delete process.env.LAX_SANDBOX; else process.env.LAX_SANDBOX = saved.sandbox;
    }
  });

  // nginx-request-logging (2026-10-19): edit/write refused /etc/nginx and /var/www.
  it("lets the file tools write system folders inside the container, through the product's own switch", async () => {
    dir = mkdtempSync(join(tmpdir(), "tb-seed-"));
    writeSeed(dir, buildSeed({ modelName: "lmstudio/m" }));
    const saved = process.env.LAX_DATA_DIR;
    process.env.LAX_DATA_DIR = dir;
    try {
      const { evaluateFileAccess } = await import("../src/security/layer/file-access.js");
      const target = process.platform === "win32" ? "C:\\Windows\\System32\\drivers\\etc\\hosts" : "/etc/nginx/nginx.conf";
      expect(evaluateFileAccess(join(dir, "workspace"), "unrestricted", () => false, "write", target).allowed).toBe(true);
    } finally {
      if (saved === undefined) delete process.env.LAX_DATA_DIR; else process.env.LAX_DATA_DIR = saved;
    }
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
