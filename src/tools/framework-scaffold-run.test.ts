// refreshOwnedViteConfig regression: already-scaffolded apps must converge to
// the current canonical vite.config when the template evolves (the merchhelm
// case: its config predated the /api/connectors dev proxy, so the app opened
// on the dev origin could never reach its connectors — vite 404'd the calls).
// Ownership is proven by the scaffold manifest; anything else is untouchable.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";

// The scaffold's npm steps go through the caged-spawn seam. The sandbox facade
// is modelled so the wrap is observable and no test reaches a real cage or the
// registry; a real node child stands in for each npm step.
const seam = vi.hoisted(() => ({
  proofPending: false,
  mode: "host" as "host" | "guarded",
  proxy: {} as Record<string, string>,
  wrapped: [] as Array<{ file: string; args: string[]; env: Record<string, string> }>,
}));
vi.mock("../sandbox/index.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../sandbox/index.js")>();
  return {
    ...actual,
    awaitSandboxProof: async () => {},
    getSandboxMode: () => seam.mode,
    ensureWinCageGrants: async () => {},
    wrapSpawnForSandbox: (file: string, args: string[], env: Record<string, string>) => {
      if (seam.proofPending) throw new actual.SandboxProofPendingError();
      seam.wrapped.push({ file, args, env });
      return { cmd: process.execPath, args: ["-e", ""] };
    },
  };
});
vi.mock("./shell-proxy-env.js", () => ({ shellProxyEnv: async () => seam.proxy, shellProxyEnvSync: () => seam.proxy }));

import { refreshOwnedViteConfig, runFrameworkScaffold } from "./framework-scaffold-run.js";
import { viteConfigText, viteScaffoldPlan, SCAFFOLD_MANIFEST_REL } from "./framework-scaffold.js";
import { SANDBOX_PROOF_PENDING_RETRY } from "../sandbox/index.js";

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "lax-scaffold-")); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

function writeManifest(framework = "vite", ownedPaths = ["vite.config.ts"]): void {
  const p = join(dir, SCAFFOLD_MANIFEST_REL);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, JSON.stringify({ framework, ownedPaths }), "utf-8");
}

describe("refreshOwnedViteConfig", () => {
  it("rewrites a stale harness-owned config to the current template", () => {
    writeManifest();
    writeFileSync(join(dir, "vite.config.ts"), "// old template without the connector proxy\n", "utf-8");
    expect(refreshOwnedViteConfig(dir, "myapp")).toBe(true);
    expect(readFileSync(join(dir, "vite.config.ts"), "utf-8")).toBe(viteConfigText("myapp"));
  });

  it("no-ops when the config already matches (idempotent across restarts)", () => {
    writeManifest();
    writeFileSync(join(dir, "vite.config.ts"), viteConfigText("myapp"), "utf-8");
    expect(refreshOwnedViteConfig(dir, "myapp")).toBe(false);
  });

  it("never touches an app without a scaffold manifest (ownership unproven)", () => {
    const handAuthored = "// the user's own vite config\n";
    writeFileSync(join(dir, "vite.config.ts"), handAuthored, "utf-8");
    expect(refreshOwnedViteConfig(dir, "myapp")).toBe(false);
    expect(readFileSync(join(dir, "vite.config.ts"), "utf-8")).toBe(handAuthored);
  });

  it("never touches a non-vite or non-owning manifest", () => {
    writeManifest("nextjs");
    writeFileSync(join(dir, "vite.config.ts"), "// stray\n", "utf-8");
    expect(refreshOwnedViteConfig(dir, "myapp")).toBe(false);

    writeManifest("vite", ["package.json"]);   // vite but config not owned
    expect(refreshOwnedViteConfig(dir, "myapp")).toBe(false);
  });

  it("returns false when there is no vite.config.ts to refresh", () => {
    writeManifest();
    expect(refreshOwnedViteConfig(dir, "myapp")).toBe(false);
  });
});

describe("viteConfigText — the canonical template's load-bearing pieces", () => {
  const text = viteConfigText("myapp");

  it("keeps the proxy base and env-driven HMR port", () => {
    expect(text).toContain("base: '/apps/myapp/'");
    expect(text).toContain("LAX_DEV_PORT");
    expect(text).toContain("strictPort: true");
  });

  it("forwards /api/connectors to LAX with the scoped capability (direct-origin apps)", () => {
    expect(text).toContain("'/api/connectors'");
    expect(text).toContain("LAX_SERVER_PORT");
    expect(text).toContain("LAX_CONNECTOR_TOKEN");
    expect(text).toMatch(/authorization.*Bearer/);
  });

  it("is exactly what the scaffold plan writes (one template, no fork)", () => {
    const planned = viteScaffoldPlan("myapp").files.find((f) => f.path === "vite.config.ts");
    expect(planned?.content).toBe(text);
  });
});

describe("runFrameworkScaffold runs npm in the shell cage", () => {
  const CREDENTIAL = "SCAFFOLD_TEST_API_KEY";
  beforeEach(() => {
    seam.proofPending = false;
    seam.mode = "host";
    seam.proxy = {};
    seam.wrapped = [];
    process.env[CREDENTIAL] = "sk-live-0123456789abcdef";
  });
  afterEach(() => { delete process.env[CREDENTIAL]; });

  it("each plan step as npm argv with no shell, on the scrubbed env with the egress proxy route", async () => {
    seam.mode = "guarded";
    seam.proxy = { HTTPS_PROXY: "http://lax:t@127.0.0.1:60090", NODE_USE_ENV_PROXY: "1" };
    const app = join(dir, "app");
    expect(await runFrameworkScaffold(app, "app", "vite")).toEqual({ scaffolded: true, framework: "vite" });

    const steps = viteScaffoldPlan("app").commands.map((c) => c.split(" ").slice(1));
    expect(steps[0]).toEqual(["create", "vite@latest", ".", "--", "--template", "react-ts"]);
    expect(seam.wrapped).toHaveLength(steps.length);
    seam.wrapped.forEach(({ file, args, env }, i) => {
      if (process.platform === "win32") {
        expect(file).toMatch(/^[a-z]:\\.*\\node\.exe$/i);
        expect(args[0]).toMatch(/\\node_modules\\npm\\bin\\npm-cli\.js$/i);
        expect(args.slice(1)).toEqual(steps[i]);
      } else {
        expect({ file, args }).toEqual({ file: "npm", args: steps[i] });
      }
      expect(env).toMatchObject({ NO_COLOR: "1", HTTPS_PROXY: "http://lax:t@127.0.0.1:60090" });
      expect(env[CREDENTIAL]).toBeUndefined();
    });
    expect(existsSync(join(app, SCAFFOLD_MANIFEST_REL))).toBe(true);
  });

  it("fails closed while the Windows cage proof is pending: no step runs, no baseline is claimed", async () => {
    seam.proofPending = true;
    const app = join(dir, "app");
    await expect(runFrameworkScaffold(app, "app", "vite")).rejects.toThrow(SANDBOX_PROOF_PENDING_RETRY);
    expect(seam.wrapped).toEqual([]);
    expect(existsSync(join(app, SCAFFOLD_MANIFEST_REL))).toBe(false);
  });
});
