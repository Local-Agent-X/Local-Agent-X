/**
 * The real thing, weekly (.github/workflows/scaffold-live.yml): every
 * framework creator in SCAFFOLDS plus the harness-owned Vite plan is run for
 * real in a temp dir, the structure kit is applied, the project's own
 * `node scripts/check-structure.mjs` and test script run, and its dev server is
 * started the way LAX starts it. Creators move (flags, templates, layouts, CLI
 * options); this is where a moved one shows up before a user's build does.
 *
 * Gated by LAX_SCAFFOLD_LIVE=1 (`npm run test:scaffold-live` sets it through
 * vitest.scaffold-live.config.ts); the default suite skips it, because it
 * downloads packages and takes minutes. Not caged: a developer's test, not a
 * build op.
 *
 * What passes: the creator exits 0, the kit lands, and the structure check is
 * green or fails ONLY on module ownership — the one decision a creator cannot
 * make for the project (a React Router `app/routes/` needs its row); any other
 * failing check, or a crash, is a kit regression. A project with a test script
 * (Vite, through the plan's vitest) must pass it. Then framework-detect must
 * name the framework that was created, and the dev command it picks must
 * serve its page on 127.0.0.1:<port> (where LAX's /apps proxy connects): a
 * 2xx, or the redirect a configured base path makes (a 404 while routes load
 * is retried). The server's process tree is killed and the port must close.
 */
import { afterAll, describe, expect, it } from "vitest";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { get } from "node:http";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { applyProjectKit, STRUCTURE_CHECK_SCRIPT } from "../src/app-scaffold/project-kit.js";
import { scaffoldCreators, viteScaffoldPlan } from "../src/tools/framework-scaffold.js";
import { detectFramework } from "../src/tools/framework-detect.js";
import { killProcessGroupSync } from "../src/process-tree-kill.js";

const LIVE = process.env.LAX_SCAFFOLD_LIVE === "1";
const STEP_TIMEOUT_MS = 10 * 60_000;
// A cold dev server installs (the command's `npm install &&`) and compiles on
// the first request.
const DEV_SERVER_TIMEOUT_MS = 4 * 60_000;
// The children get the environment a LAX build gives them, not this runner's:
// vitest's own variables leak into every child, and Astro's dev server under
// VITEST=true serves nothing (404 on every page).
const ENV: NodeJS.ProcessEnv = { NO_COLOR: "1", CI: "1" };
for (const [k, v] of Object.entries(process.env)) {
  if (!k.startsWith("VITEST") && k !== "NODE_ENV" && !(k in ENV)) ENV[k] = v;
}
const dirs: string[] = [];
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

function run(command: string, cwd: string): { status: number | null; out: string } {
  const r = spawnSync(command, { cwd, shell: true, encoding: "utf-8", timeout: STEP_TIMEOUT_MS, env: ENV });
  return { status: r.status, out: `$ ${command}\n${r.stdout}${r.stderr}` };
}

/** The plan's commands and files for Vite (what the harness really runs); the
 *  creator then an install for every other framework. */
function scaffold(framework: string, creator: string, dir: string): string {
  const log: string[] = [];
  if (framework === "vite") {
    const plan = viteScaffoldPlan("live-app");
    for (const c of plan.commands) {
      const r = run(c, dir);
      log.push(r.out);
      expect(r.status, log.join("\n")).toBe(0);
    }
    for (const f of plan.files) {
      mkdirSync(dirname(join(dir, f.path)), { recursive: true });
      writeFileSync(join(dir, f.path), f.content);
    }
    return log.join("\n");
  }
  for (const c of [creator, "npm install"]) {
    const r = run(c, dir);
    log.push(r.out);
    expect(r.status, log.join("\n")).toBe(0);
  }
  return log.join("\n");
}

const onlyOwnershipFailed = (out: string): boolean =>
  /check-structure: 1 of 4 checks failed/.test(out) && /check-module-owners: \d+ module\(s\) with no owner/.test(out);

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer().once("error", reject).listen(0, "127.0.0.1", () => {
      const { port } = srv.address() as { port: number };
      srv.close(() => resolve(port));
    });
  });
}

/** The HTTP status 127.0.0.1:<port>/ answers with, or null when nothing does. */
function httpStatus(port: number): Promise<number | null> {
  return new Promise((resolve) => {
    const req = get({ host: "127.0.0.1", port, path: "/", timeout: 60_000, agent: false }, (res) => {
      res.resume();
      resolve(res.statusCode ?? null);
    });
    req.on("timeout", () => req.destroy());
    req.on("error", () => resolve(null));
  });
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface DevServer { child: ChildProcess; output: () => string; exited: () => boolean }

function startDevServer(command: string, cwd: string): DevServer {
  // Detached on POSIX so the kill takes the whole process group (npm → node).
  const child = spawn(command, { cwd, shell: true, env: ENV, detached: process.platform !== "win32", windowsHide: true });
  let out = `$ ${command}\n`;
  let exited = false;
  child.stdout?.on("data", (d) => { out += String(d); });
  child.stderr?.on("data", (d) => { out += String(d); });
  child.on("exit", () => { exited = true; });
  return { child, output: () => out.slice(-4000), exited: () => exited };
}

/** Poll until the server serves the page (below 400), it exits, or the deadline passes. */
async function waitForHttp(server: DevServer, port: number): Promise<number | null> {
  const deadline = Date.now() + DEV_SERVER_TIMEOUT_MS;
  let last: number | null = null;
  while (Date.now() < deadline && !server.exited()) {
    last = await httpStatus(port);
    if (last !== null && last < 400) return last;
    await sleep(1000);
  }
  return last;
}

async function portClosed(port: number): Promise<boolean> {
  for (let i = 0; i < 30; i++) {
    if ((await httpStatus(port)) === null) return true;
    await sleep(500);
  }
  return false;
}

describe.skipIf(!LIVE)("scaffold live: every creator, then the kit, the project's own checks, and its dev server", () => {
  it.each(scaffoldCreators())("$label", async ({ framework, creator }) => {
    // A real app dir is workspace/apps/<lowercase-name>; creators derive the
    // package name from the directory and reject npm-invalid names.
    const parent = mkdtempSync(join(tmpdir(), `lax-scaffold-live-${framework}-`));
    dirs.push(parent);
    const dir = join(parent, "live-app");
    mkdirSync(dir);
    const log = scaffold(framework, creator, dir);
    expect(existsSync(join(dir, "package.json")), log).toBe(true);

    // A creator may ship its own AGENTS.md (Astro's minimal template does);
    // the kit never overwrites a file that exists, so that one is skipped.
    const kit = applyProjectKit(dir, { projectName: "live-app" });
    expect(kit.written, log).toEqual(expect.arrayContaining(["ARCHITECTURE.md", "scripts/check-structure.mjs"]));
    expect(kit.wiredNpmScripts).toBe(true);

    const check = run(`node ${STRUCTURE_CHECK_SCRIPT}`, dir);
    expect(check.status === 0 || (check.status === 1 && onlyOwnershipFailed(check.out)), check.out).toBe(true);

    const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf-8")) as { scripts?: Record<string, string> };
    if (pkg.scripts?.test) {
      const test = run("npm test", dir);
      expect(test.status, test.out).toBe(0);
    }

    const detected = detectFramework(dir);
    expect(detected.framework, detected.evidence).toBe(framework);
    const port = await freePort();
    const command = detected.devCommand(port);
    expect(command, detected.evidence).not.toBeNull();
    const server = startDevServer(command!, dir);
    let status: number | null;
    try {
      status = await waitForHttp(server, port);
      expect(status !== null && status < 400, `dev server on 127.0.0.1:${port} answered ${status}\n${server.output()}`).toBe(true);
    } finally {
      if (server.child.pid) killProcessGroupSync(server.child.pid, server.child);
    }
    expect(await portClosed(port), `port ${port} still answers after the tree kill`).toBe(true);

    console.log(`[scaffold-live] ${framework}: creator ok, kit ${kit.written.length} files written (${kit.skipped.join(", ") || "none"} already there; creator docs ${kit.creatorDocs.join(", ") || "none"}), structure ${check.status === 0 ? "green" : "ownership rows pending"}, test script ${pkg.scripts?.test ? "passed" : "none"}, dev server (${detected.evidence}) answered ${status} on ${port}`);
  });
});
