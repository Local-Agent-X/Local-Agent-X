// The installer's settings step decides a fresh install's web-access posture:
// strict, with nothing allowed yet, so the agent reaches a site only after the
// user allows it. An install that already has either policy file is the
// user's; the step must not rewrite it.
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { scaffoldSettings } from "../scripts/installer/core-steps.mjs";
import { bindInstallerDataRoot } from "../scripts/installer/data-root.mjs";

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
  it("a fresh install is strict with an empty allowlist", () => {
    const { directory, context } = freshContext();
    scaffoldSettings(context, false);
    expect(read(join(directory, "settings.json"))).toMatchObject({ embeddingProvider: "local" });
    expect(read(join(directory, "security.json"))).toEqual({ egressMode: "strict" });
    expect(read(join(directory, "egress-allowlist.json"))).toEqual([]);
  });

  it("an existing install with NEITHER policy file (the common case) is left alone: config.json is the install's identity", () => {
    const { directory, context } = freshContext();
    writeFileSync(join(directory, "config.json"), JSON.stringify({ authToken: "abc", projectRoot: directory }));
    writeFileSync(join(directory, "settings.json"), JSON.stringify({ temperature: 0.7 }));
    scaffoldSettings(context, true);
    expect(existsSync(join(directory, "security.json"))).toBe(false);
    expect(existsSync(join(directory, "egress-allowlist.json"))).toBe(false);
  });

  it("an install with its own security.json keeps it, and gets no allowlist written", () => {
    const { directory, context } = freshContext();
    writeFileSync(join(directory, "security.json"), JSON.stringify({ fileAccessMode: "workspace" }));
    scaffoldSettings(context, true);
    expect(read(join(directory, "security.json"))).toEqual({ fileAccessMode: "workspace" });
    expect(existsSync(join(directory, "egress-allowlist.json"))).toBe(false);
  });

  it("an install with its own allowlist keeps it, and its mode is left as it was", () => {
    const { directory, context } = freshContext();
    writeFileSync(join(directory, "egress-allowlist.json"), JSON.stringify(["api.example.com"]));
    scaffoldSettings(context, true);
    expect(read(join(directory, "egress-allowlist.json"))).toEqual(["api.example.com"]);
    expect(existsSync(join(directory, "security.json"))).toBe(false);
  });
});
