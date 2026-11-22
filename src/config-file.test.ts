// config.json has one reader and one key-setter for code that is not the
// running config (readConfigFile, patchConfigFile), and one answer to "which
// Ollama endpoint is this install configured for" (configuredOllamaUrl), which
// the network policy's loopback carve-out reads.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { configuredOllamaUrl, loadConfig, patchConfigFile, readConfigFile } from "./config.js";
import { ollamaLoopbackPort, ollamaPortFromUrl } from "./security/layer/security-config.js";

const ENV = ["LAX_DATA_DIR", "LAX_OLLAMA_URL", "LAX_WORKSPACE"] as const;
const previous = new Map<string, string | undefined>();
let dataDir = "";
let configPath = "";

beforeEach(() => {
  for (const name of ENV) previous.set(name, process.env[name]);
  dataDir = mkdtempSync(join(tmpdir(), "config-file-"));
  configPath = join(dataDir, "config.json");
  process.env.LAX_DATA_DIR = dataDir;
  process.env.LAX_WORKSPACE = join(dataDir, "workspace");
  mkdirSync(process.env.LAX_WORKSPACE);
  delete process.env.LAX_OLLAMA_URL;
});

afterEach(() => {
  for (const name of ENV) {
    const value = previous.get(name);
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  rmSync(dataDir, { recursive: true, force: true });
});

const onDisk = () => JSON.parse(readFileSync(configPath, "utf-8")) as Record<string, unknown>;

describe("readConfigFile", () => {
  it("returns every key on disk, and nothing for a missing or corrupt file", () => {
    expect(readConfigFile()).toEqual({});
    writeFileSync(configPath, "{ not json");
    expect(readConfigFile()).toEqual({});
    writeFileSync(configPath, JSON.stringify({ port: 7100, projectRoot: "C:/dev/repo" }));
    expect(readConfigFile()).toEqual({ port: 7100, projectRoot: "C:/dev/repo" });
  });
});

describe("patchConfigFile", () => {
  it("sets the given keys and keeps every other key as it was", () => {
    writeFileSync(configPath, JSON.stringify({ port: 7007, authToken: "kept", projectRoot: "C:/dev/repo" }));
    patchConfigFile({ port: 7100, workspace: "D:/work" });
    expect(onDisk()).toEqual({ port: 7100, authToken: "kept", projectRoot: "C:/dev/repo", workspace: "D:/work" });
  });

  it("writes the file it is given, not the default data dir's", () => {
    const elsewhere = join(dataDir, "other");
    mkdirSync(elsewhere);
    const otherPath = join(elsewhere, "config.json");
    writeFileSync(otherPath, JSON.stringify({ port: 7007 }));
    patchConfigFile({ port: 7200 }, otherPath);
    expect(JSON.parse(readFileSync(otherPath, "utf-8"))).toEqual({ port: 7200 });
    expect(readConfigFile()).toEqual({});
  });

  it.skipIf(process.platform === "win32")("keeps the file private", () => {
    writeFileSync(configPath, JSON.stringify({ port: 7007 }), { mode: 0o644 });
    patchConfigFile({ port: 7100 });
    expect(statSync(configPath).mode & 0o777).toBe(0o600);
  });
});

describe("configuredOllamaUrl", () => {
  it("is the default with nothing configured", () => {
    expect(configuredOllamaUrl()).toBe("http://127.0.0.1:11434");
  });

  it("is config.json's value, read fresh", () => {
    writeFileSync(configPath, JSON.stringify({ ollamaUrl: " http://127.0.0.1:8080 " }));
    expect(configuredOllamaUrl()).toBe("http://127.0.0.1:8080");
    writeFileSync(configPath, JSON.stringify({ ollamaUrl: "" }));
    expect(configuredOllamaUrl()).toBe("");
  });

  it("is the LAX_OLLAMA_URL override when one is set", () => {
    writeFileSync(configPath, JSON.stringify({ ollamaUrl: "http://127.0.0.1:8080" }));
    process.env.LAX_OLLAMA_URL = "http://127.0.0.1:9191";
    expect(configuredOllamaUrl()).toBe("http://127.0.0.1:9191");
  });
});

// The server computes the policy with what is on disk and in its environment;
// a worker it starts is handed the running value as LAX_OLLAMA_URL. Restart
// recovery refuses a worker whose policy differs from the one the operation
// started under, so the carve-out must name the running config's port in both.
describe("the loopback carve-out follows the running config", () => {
  const cases: Array<{ name: string; disk?: string; env?: string }> = [
    { name: "nothing configured" },
    { name: "config.json only", disk: "http://127.0.0.1:8080" },
    { name: "override only", env: "http://127.0.0.1:9191" },
    { name: "override over config.json", disk: "http://127.0.0.1:8080", env: "http://127.0.0.1:9191" },
    { name: "a non-loopback override", disk: "http://127.0.0.1:8080", env: "http://ollama.box:11434" },
  ];
  for (const c of cases) {
    it(c.name, () => {
      writeFileSync(configPath, JSON.stringify({ authToken: "test-token", ...(c.disk ? { ollamaUrl: c.disk } : {}) }));
      if (c.env) process.env.LAX_OLLAMA_URL = c.env;
      const running = loadConfig().ollamaUrl;
      expect(ollamaLoopbackPort()).toBe(ollamaPortFromUrl(running));

      // What a worker started from this server computes: its override is the
      // running value.
      process.env.LAX_OLLAMA_URL = running;
      expect(ollamaLoopbackPort()).toBe(ollamaPortFromUrl(running));
    });
  }
});
