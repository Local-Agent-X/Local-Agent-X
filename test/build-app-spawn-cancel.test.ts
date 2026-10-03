/**
 * Real-subprocess tests for src/tools/build-app-spawn.ts.
 *
 * Cancel propagation — closes Phase-2 gap A
 * (docs/migration/build-app-to-canonical-op.md): the controller's abort
 * signal must trigger the subprocess tree kill within a deadline. Exercised
 * on the same tree-kill + AbortSignal pattern the spawn util uses, with a
 * long-running node child.
 *
 * The CLI sub-agent's env and command — runCliBuild runs against stub
 * `codex` / `claude` CLIs put on the PATH, which record the env they were
 * given and write an app, next to lookalikes planted in the app dir.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { killProcessTree } from "../src/process-tree-kill.js";
import { runCliBuild } from "../src/tools/build-app-spawn.js";

// A codex or claude installed on the test machine sits in the npm global bin,
// which the child env puts ahead of the PATH, and would run instead of the stub.
vi.mock("../src/anthropic-client/cli-path.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/anthropic-client/cli-path.js")>()),
  getNpmGlobalBin: () => "",
}));

describe("build-app-spawn cancel propagation — subprocess dies on abort", () => {
  it("AbortSignal abort triggers killProcessTree and subprocess exits within 3s", async () => {
    // Long-running node subprocess that does nothing until killed. We use
    // node directly (always available in dev) instead of codex / claude
    // which may not be installed in CI.
    const proc = spawn(process.execPath, ["-e", "setInterval(()=>{}, 1000)"], {
      stdio: ["pipe", "pipe", "pipe"],
      shell: process.platform === "win32",
    });

    const controller = new AbortController();
    controller.signal.addEventListener("abort", () => killProcessTree(proc));

    const start = Date.now();
    const exitPromise = new Promise<{ code: number | null; elapsedMs: number }>((resolveP) => {
      proc.on("close", (code) => resolveP({ code, elapsedMs: Date.now() - start }));
    });

    // Give the subprocess a moment to actually start, then fire abort.
    await new Promise((r) => setTimeout(r, 100));
    controller.abort();

    const result = await Promise.race([
      exitPromise,
      new Promise<{ code: number | null; elapsedMs: number }>((_, rejectP) =>
        setTimeout(() => rejectP(new Error("subprocess did not die within 3s of abort")), 3000),
      ),
    ]);

    expect(result.elapsedMs).toBeLessThan(3000);
  });
});

describe("build-app-spawn CLI sub-agent — env and command", () => {
  const win = process.platform === "win32";
  const SECRETS = {
    OPENAI_API_KEY: "sk-openai-test",
    ANTHROPIC_API_KEY: "sk-ant-test",
    XAI_API_KEY: "xai-test",
    GITHUB_TOKEN: "ghp-test",
    STRIPE_SECRET_KEY: "sk-stripe-test",
  };
  const STUB = [
    `import { writeFileSync } from "node:fs";`,
    `process.stdin.resume();`,
    `process.stdin.on("end", () => {`,
    `  writeFileSync("env.json", JSON.stringify(process.env));`,
    `  writeFileSync("index.html", "<!doctype html><html><head><script>" + "/* stub */".repeat(40) + "</script></head><body><div id='app'></div></body></html>");`,
    `});`,
  ].join("\n");
  const saved: Record<string, string | undefined> = {};
  let stubDir = "";
  let appDir = "";

  function writeProgram(dir: string, name: string, body: { win: string; posix: string }): void {
    if (win) writeFileSync(join(dir, `${name}.cmd`), `@echo off\r\n${body.win}\r\n`);
    else writeFileSync(join(dir, name), `#!/bin/sh\n${body.posix}\n`, { mode: 0o755 });
  }

  function plantLookalikes(): void {
    for (const name of ["codex", "claude", "node"]) {
      writeProgram(appDir, name, { win: "echo planted> planted.txt", posix: "echo planted > planted.txt" });
    }
  }

  function setPath(...dirs: string[]): void {
    process.env.PATH = [...dirs, saved.PATH ?? ""].join(delimiter);
  }

  function build(provider: "codex" | "anthropic") {
    return runCliBuild({ provider, prompt: "build an app", appDir, appUrl: "/apps/stub/" });
  }

  beforeEach(() => {
    for (const key of ["PATH", ...Object.keys(SECRETS)]) saved[key] = process.env[key];
    Object.assign(process.env, SECRETS);
    stubDir = mkdtempSync(join(tmpdir(), "build-cli-stub-"));
    appDir = mkdtempSync(join(tmpdir(), "build-cli-app-"));
    writeFileSync(join(stubDir, "cli-stub.mjs"), STUB);
    // Like npm's shims, the stubs start a bare `node`, so its lookup is tested too.
    for (const name of ["codex", "claude"]) {
      writeProgram(stubDir, name, { win: `node "%~dp0cli-stub.mjs"`, posix: `exec node "$(dirname "$0")/cli-stub.mjs"` });
    }
  });

  afterEach(() => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    rmSync(stubDir, { recursive: true, force: true });
    rmSync(appDir, { recursive: true, force: true });
  });

  it.each([
    ["codex", "OPENAI_API_KEY"],
    ["anthropic", "ANTHROPIC_API_KEY"],
  ] as const)("the %s sub-agent gets %s and none of the server's other secrets", async (provider, own) => {
    setPath(stubDir);
    const result = await build(provider);
    expect(result.isError, result.content).toBeFalsy();
    const env = JSON.parse(readFileSync(join(appDir, "env.json"), "utf-8")) as Record<string, string>;
    expect(env[own]).toBe(SECRETS[own]);
    for (const key of Object.keys(SECRETS).filter((k) => k !== own)) {
      expect(env[key], key).toBeUndefined();
    }
  });

  it("runs the CLI from the PATH and the node it starts, not the app dir's lookalikes", async () => {
    plantLookalikes();
    setPath(".", stubDir);
    const result = await build("codex");
    expect(result.isError, result.content).toBeFalsy();
    expect(existsSync(join(appDir, "planted.txt"))).toBe(false);
    expect(existsSync(join(appDir, "env.json"))).toBe(true);
  });

  it("reports a CLI missing from the PATH as not installed, without running the app dir's copy", async () => {
    plantLookalikes();
    // Only the stub dir, so a codex installed on this machine is not found either.
    process.env.PATH = [".", stubDir].join(delimiter);
    rmSync(join(stubDir, win ? "codex.cmd" : "codex"));
    const result = await build("codex");
    expect(result.isError).toBe(true);
    expect(result.content).toContain("Install with: npm install -g @openai/codex");
    expect(existsSync(join(appDir, "planted.txt"))).toBe(false);
  });
});
