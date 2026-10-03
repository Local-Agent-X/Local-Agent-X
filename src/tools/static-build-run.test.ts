// The static build runs the app's agent-written vite config and plugins, so it
// goes through the caged-spawn seam. The sandbox facade is modelled so the
// wrap is observable and no test reaches a real cage; the "build" that runs in
// place of npx is a real node child.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const seam = vi.hoisted(() => ({
  proofPending: false,
  wrapped: [] as Array<{ file: string; args: string[]; env: Record<string, string> }>,
  runInstead: null as null | { cmd: string; args: string[] },
}));

vi.mock("../sandbox/index.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../sandbox/index.js")>();
  return {
    ...actual,
    awaitSandboxProof: async () => {},
    getSandboxMode: () => "host",
    wrapSpawnForSandbox: (file: string, args: string[], env: Record<string, string>) => {
      if (seam.proofPending) throw new actual.SandboxProofPendingError();
      seam.wrapped.push({ file, args, env });
      return seam.runInstead ?? { cmd: file, args };
    },
  };
});
vi.mock("./shell-proxy-env.js", () => ({ shellProxyEnv: async () => ({}), shellProxyEnvSync: () => ({}) }));

import { runStaticBuild } from "./static-build-run.js";
import { SANDBOX_PROOF_PENDING_RETRY } from "../sandbox/index.js";

const node = (script: string) => ({ cmd: process.execPath, args: ["-e", script] });
const BUILDS_DIST = node("const fs = require('fs'); fs.mkdirSync('dist'); fs.writeFileSync('dist/index.html', '<p>'); console.log('built in 1s')");
const CREDENTIAL = "STATIC_BUILD_TEST_API_KEY";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "static-build-"));
  seam.proofPending = false;
  seam.wrapped = [];
  seam.runInstead = null;
  process.env[CREDENTIAL] = "sk-live-0123456789abcdef";
});
afterEach(() => {
  delete process.env[CREDENTIAL];
  rmSync(dir, { recursive: true, force: true });
});

describe("runStaticBuild runs the build in the shell cage", () => {
  it("as npx argv with no shell, on the scrubbed env", async () => {
    seam.runInstead = BUILDS_DIST;
    const events: Array<{ type: string; [k: string]: unknown }> = [];
    const result = await runStaticBuild(dir, "vite", { toolName: "app_rebuild", onEvent: (e) => events.push(e) });

    expect(result).toEqual({ ok: true, distDir: "dist" });
    expect(seam.wrapped).toHaveLength(1);
    const { file, args, env } = seam.wrapped[0];
    if (process.platform === "win32") {
      expect(file).toMatch(/^[a-z]:\\.*\\node\.exe$/i);
      expect(args[0]).toMatch(/\\node_modules\\npm\\bin\\npx-cli\.js$/i);
      expect(args.slice(1)).toEqual(["vite", "build"]);
    } else {
      expect({ file, args }).toEqual({ file: "npx", args: ["vite", "build"] });
    }
    expect(env.NO_COLOR).toBe("1");
    expect(env[CREDENTIAL]).toBeUndefined();
    expect(events).toContainEqual({ type: "tool_progress", toolName: "app_rebuild", message: "build: built in 1s" });
  });

  it("fails closed while the Windows cage proof is pending: nothing runs", async () => {
    seam.proofPending = true;
    seam.runInstead = BUILDS_DIST;
    const result = await runStaticBuild(dir, "vite");

    expect(result.ok).toBe(false);
    expect(result.error).toContain(SANDBOX_PROOF_PENDING_RETRY);
    expect(seam.wrapped).toEqual([]);
    expect(existsSync(join(dir, "dist"))).toBe(false);
  });

  it("a failing build reports its exit code and stderr tail", async () => {
    seam.runInstead = node("console.error('Could not resolve ./App'); process.exit(2)");
    const result = await runStaticBuild(dir, "vite");
    expect(result.ok).toBe(false);
    expect(result.error).toBe("static build exited 2: npx vite build\nCould not resolve ./App");
  });
});
