// registerDevServer stops the app's running dev server and reclaims its port,
// then starts the new one synchronously, which a Windows cage still proving its
// fence or still granting its sandbox user refuses. The app_serve_* tools can
// wait, so they wait for the cage first, and when it is still not ready they
// say why without calling registerDevServer: the running server is left alone.
import { beforeEach, describe, expect, it, vi } from "vitest";

const seam = vi.hoisted(() => ({
  events: [] as string[],
  cageReady: Promise.resolve(),
  cageFailure: null as Error | null,
  proofPending: false,
}));
vi.mock("./caged-spawn.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./caged-spawn.js")>()),
  // As the real wait: an abort ends it at once and the caller reads its signal.
  awaitCageReady: async (signal?: AbortSignal) => {
    seam.events.push("cage");
    await Promise.race([seam.cageReady, new Promise<void>((r) => signal?.addEventListener("abort", () => r(), { once: true }))]);
    if (seam.cageFailure && !signal?.aborted) throw seam.cageFailure;
  },
}));
vi.mock("../sandbox/index.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../sandbox/index.js")>();
  return { ...actual, getSandboxStatus: () => ({ ...actual.getSandboxStatus(), proofPending: seam.proofPending }) };
});
vi.mock("./dev-server.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./dev-server.js")>()),
  registerDevServer: (input: { appId: string; port: number; cwd?: string; kind?: "backend" | "frontend" }) => {
    seam.events.push(`register:${input.appId}`);
    return { ok: true as const, connector: `dev-${input.appId}`, sessionId: "s1", port: input.port, cwd: input.cwd ?? "", restarted: true, kind: input.kind ?? "backend" };
  },
  stopDevServer: () => { seam.events.push("stop"); },
}));
vi.mock("./dev-server-readiness.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./dev-server-readiness.js")>()),
  waitForBackend: async () => ({ status: "listening" as const }),
}));

import { WinCageGrantFailedError } from "../sandbox/win-cage-grants.js";
import { appServeBackendTool, appServeFrontendTool } from "./dev-server-tools.js";

const prevMode = process.env.LAX_SANDBOX;
beforeEach(() => {
  // The real status underneath stays on the host; only proofPending is modelled.
  process.env.LAX_SANDBOX = "host";
  seam.events = [];
  seam.cageReady = Promise.resolve();
  seam.cageFailure = null;
  seam.proofPending = false;
  return () => { if (prevMode === undefined) delete process.env.LAX_SANDBOX; else process.env.LAX_SANDBOX = prevMode; };
});

const backend = (signal?: AbortSignal) => appServeBackendTool.execute({ app_id: "notes", command: "node server.js", port: 5180 }, signal);
const frontend = () => appServeFrontendTool.execute({ app_id: "spa", command: "npm run dev", port: 5181 });
const tick = () => new Promise((r) => setTimeout(r, 20));

describe("app_serve_* wait for the shell cage before replacing a running server", () => {
  it("app_serve_backend registers only once the cage is ready", async () => {
    let release!: () => void;
    seam.cageReady = new Promise<void>((r) => { release = r; });
    const run = backend();
    await tick();
    expect(seam.events).toEqual(["cage"]);
    release();
    expect((await run).isError).toBeFalsy();
    expect(seam.events).toEqual(["cage", "register:notes"]);
  });

  it("app_serve_frontend registers only once the cage is ready", async () => {
    let release!: () => void;
    seam.cageReady = new Promise<void>((r) => { release = r; });
    const run = frontend();
    await tick();
    expect(seam.events).toEqual(["cage"]);
    release();
    expect((await run).isError).toBeFalsy();
    expect(seam.events).toEqual(["cage", "register:spa"]);
  });

  it("grants that failed: the latched reason, and nothing stopped", async () => {
    seam.cageFailure = new WinCageGrantFailedError("the helper exited with 5: Access is denied.");
    for (const [run, label] of [[backend, "backend"], [frontend, "frontend dev server"]] as const) {
      seam.events = [];
      const r = await run();
      expect(r.isError).toBe(true);
      expect(String(r.content)).toMatch(new RegExp(`^Could not start ${label}: The Windows shell cage could not give its sandbox user access .*\\(the helper exited with 5: Access is denied\\.\\).*restarting the app also retries it\\. Nothing was stopped or started\\.$`));
      expect(seam.events).toEqual(["cage"]);
    }
  });

  it("a proof that outlasted the wait: retry later, and nothing stopped", async () => {
    seam.proofPending = true;
    const r = await backend();
    expect(r).toEqual({ isError: true, content: "Could not start backend: The Windows shell cage is still being verified; try again in a few seconds. Nothing was stopped or started." });
    expect(seam.events).toEqual(["cage"]);
  });

  it("an abort during the wait stops and starts nothing", async () => {
    seam.cageReady = new Promise<void>(() => {});
    const controller = new AbortController();
    const run = backend(controller.signal);
    await tick();
    controller.abort();
    expect(await run).toEqual({ isError: true, content: "Could not start backend: Aborted; nothing was stopped or started." });
    expect(seam.events).toEqual(["cage"]);
  });
});
