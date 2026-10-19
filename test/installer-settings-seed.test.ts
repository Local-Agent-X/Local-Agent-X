// The installer's settings step and a fresh install's web-access posture: any
// public site (permissive), strict being the user's opt-in in Settings. The
// step writes no policy file: the allowlist doubles as the trusted
// destinations the outbound secret scan reads in both modes, so the search
// providers strict starts with are written when the user turns strict on
// (EgressPolicyState.setMode), not here. An install that already has either
// policy file is the user's; the step must not rewrite it.
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { scaffoldSettings } from "../scripts/installer/core-steps.mjs";
import { bindInstallerDataRoot } from "../scripts/installer/data-root.mjs";
import { loadEgressMode } from "../src/security/layer/security-config.js";
import { loadEgressConfig } from "../src/security/layer/network-policy.js";

const directories: string[] = [];
afterEach(() => { for (const d of directories.splice(0)) rmSync(d, { recursive: true, force: true }); });

function freshContext() {
  const directory = mkdtempSync(join(tmpdir(), "lax-install-settings-"));
  directories.push(directory);
  const context = {
    reporter: { step: () => true, ok: () => {}, stepDone: () => {} },
    dataDirectory: directory,
  };
  bindInstallerDataRoot(context);
  return { directory, context };
}

const read = (path: string) => JSON.parse(readFileSync(path, "utf-8"));

describe("installer settings step: web access", () => {
  // Web access on a fresh install is "any public site": the outbound checks
  // (secret scan, data-flow evidence, SSRF) guard what leaves, so the step
  // writes no web policy. Strict mode stays the user's choice in Settings.
  it("a fresh install writes no web-access policy, so it is permissive", () => {
    const { directory, context } = freshContext();
    scaffoldSettings(context, false);
    expect(read(join(directory, "settings.json"))).toMatchObject({ embeddingProvider: "local" });
    expect(existsSync(join(directory, "security.json"))).toBe(false);
    expect(existsSync(join(directory, "egress-allowlist.json"))).toBe(false);
    // Read the way the server reads it: permissive.
    const prev = process.env.LAX_DATA_DIR;
    process.env.LAX_DATA_DIR = directory;
    try {
      expect(loadEgressMode()).toBe("permissive");
      expect(loadEgressConfig().mode).toBe("permissive");
    } finally {
      if (prev === undefined) delete process.env.LAX_DATA_DIR; else process.env.LAX_DATA_DIR = prev;
    }
  });

  it("an existing install with neither policy file gets none written", () => {
    const { directory, context } = freshContext();
    writeFileSync(join(directory, "config.json"), JSON.stringify({ authToken: "abc", projectRoot: directory }));
    writeFileSync(join(directory, "settings.json"), JSON.stringify({ temperature: 0.7 }));
    scaffoldSettings(context, true);
    expect(read(join(directory, "settings.json"))).toEqual({ temperature: 0.7 });
    expect(existsSync(join(directory, "security.json"))).toBe(false);
    expect(existsSync(join(directory, "egress-allowlist.json"))).toBe(false);
  });

  it("an install with its own policy files keeps them untouched", () => {
    const { directory, context } = freshContext();
    writeFileSync(join(directory, "security.json"), JSON.stringify({ egressMode: "strict" }));
    writeFileSync(join(directory, "egress-allowlist.json"), JSON.stringify(["api.example.com"]));
    scaffoldSettings(context, true);
    expect(read(join(directory, "security.json"))).toEqual({ egressMode: "strict" });
    expect(read(join(directory, "egress-allowlist.json"))).toEqual(["api.example.com"]);
  });
});
