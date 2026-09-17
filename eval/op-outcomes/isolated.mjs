// One throwaway LAX server per case: fresh data dir, fresh workspace copied
// from fixtures/workspace, its own port. Nothing a case does reaches the
// user's ~/.lax (sessions, memory, learned protocols) or real workspace.
//
// Provider auth reuses the self_edit probe's mechanism rather than a second
// one: seedProbeProvider() names the user's canonical credential file, and
// LAX_SELF_EDIT_PROBE=1 + LAX_PROBE_PROVIDER_AUTH_PATH let the child read it in
// place (decrypted with the key beside it — nothing is copied or re-encrypted).
//
// The workspace lifecycle logs that it refuses to junction <repo>/workspace to
// this temp workspace. That is expected and harmless here: file, search and
// shell tools resolve against the configured workspace (LAX_WORKSPACE), and the
// refusal is the guard that keeps the user's real workspace from being migrated.
import { execSync, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { seedProbeProvider } from "../../src/self-edit/sandbox-gates.ts";
import { killProcessTree } from "../../src/process-tree-kill.ts";

const BOOT_TIMEOUT_MS = 180_000;

/**
 * The servers boot the compiled build (`dist/`), like the self_edit probe:
 * tsx would recompile the whole tree for every run, and two batches booting in
 * parallel stalled past the boot timeout. So a run must refuse a dist that
 * predates source changes, or the results would describe old code.
 */
export function assertDistMatchesSource(repoRoot) {
  const refPath = join(repoRoot, "dist", ".builtref");
  if (!existsSync(join(repoRoot, "dist", "index.js")) || !existsSync(refPath)) {
    throw new Error("dist/ is missing — run `npm run build` first");
  }
  const builtRef = readFileSync(refPath, "utf8").trim();
  try {
    execSync(`git diff --quiet ${builtRef} HEAD -- src config package.json package-lock.json`, { cwd: repoRoot, stdio: "ignore" });
    execSync("git diff --quiet HEAD -- src config package.json package-lock.json", { cwd: repoRoot, stdio: "ignore" });
  } catch {
    throw new Error(`dist/ was built from ${builtRef.slice(0, 8)} but src/config changed since — run \`npm run build\` first`);
  }
}

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

/**
 * `seedWorkspace` is the directory copied in as the workspace — the op-outcomes
 * fixtures by default; null starts it empty (the polyglot rig writes its own
 * exercise into it). `fixturePort` is optional for a rig with no fixture server.
 * `toolPolicyRules` are seeded into the server's tool-policy.json; LAX merges
 * its defaults under them at boot, so a rig can deny a tool without replacing
 * the product policy.
 */
export async function startIsolatedServer({ repoRoot, provider, model, fixturePort, logLines = 200,
  seedWorkspace = join(repoRoot, "eval", "op-outcomes", "fixtures", "workspace"), toolPolicyRules = [] }) {
  // Two unrelated temp dirs. With the data dir beside the workspace, a model
  // listing the workspace's parent walked straight into the server's own
  // sessions and operations (muse, grade-school, 2026-09-17) — no real
  // install puts ~/.lax next to the user's project.
  const root = mkdtempSync(join(tmpdir(), "lax-eval-"));
  const dataDir = join(root, "data");
  const workspaceRoot = mkdtempSync(join(tmpdir(), "lax-ws-"));
  const workspace = join(workspaceRoot, "workspace");
  if (seedWorkspace) cpSync(seedWorkspace, workspace, { recursive: true });
  else mkdirSync(workspace, { recursive: true });

  mkdirSync(dataDir, { recursive: true });
  const seed = seedProbeProvider(dataDir, provider);
  if (seed.unavailable) throw new Error(`${provider}: ${seed.unavailable}`);
  writeFileSync(join(dataDir, "settings.json"), JSON.stringify({ provider, model }));
  if (toolPolicyRules.length) {
    // "deny" is the product default (src/tool-policy/default-rules.ts).
    writeFileSync(join(dataDir, "tool-policy.json"), JSON.stringify({ defaultDecision: "deny", rules: toolPolicyRules }));
  }
  // The fixture server is a loopback port the network policy must treat as a
  // registered local service — the same knob a user sets for their own dev servers.
  // File access is left at the product default ("unrestricted"), so a run
  // measures a normal install. Forcing "workspace" was tried and changed the
  // measurement: relative agent paths anchor to the project root (the
  // workspace's parent), so `cleanup/x.log` becomes a security BLOCK instead of
  // a recoverable "not found", and muse gave up where it had recovered before.
  // The cost of the default is that a model can still wander the real disk
  // (one grok run found this repo's fixture copy) — visible in the replies.
  writeFileSync(join(dataDir, "security.json"), JSON.stringify({ localServicePorts: fixturePort ? [fixturePort] : [] }));

  const port = await freePort();
  const token = randomBytes(24).toString("hex");
  const tail = [];
  const child = spawn(process.execPath, ["--max-old-space-size=4096", "dist/index.js"], {
    cwd: repoRoot,
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      ...(seed.credentialPath ? { LAX_PROBE_PROVIDER_AUTH_PATH: seed.credentialPath } : {}),
      LAX_SELF_EDIT_PROBE: "1",
      // The probe flag above (needed to read credentials in place) also arms a
      // self-destruct sized for a 5-minute bind check. At its 10-minute default
      // these servers died MID-TURN and the runs were scored as model failures
      // — every case over ~10 minutes was measuring the harness killing itself.
      // Comfortably past the per-turn ceiling; the parent-death watchdog, not
      // this backstop, is what reaps an orphan when the runner dies.
      LAX_PROBE_MAX_LIFETIME_MS: String(45 * 60_000),
      LAX_DATA_DIR: dataDir,
      LAX_WORKSPACE: workspace,
      LAX_PORT: String(port),
      LAX_AUTH_TOKEN: token,
      LAX_PROBE_PARENT_PID: String(process.pid),
      LAX_BROWSER_HEADLESS: "1",
      LAX_INTEGRITY_WARN_ONLY: "1",
      // Profile any event-loop stall of 4s+ (the product default is 30s). Eval
      // runs are where short stalls get noticed, and a stall with no profile
      // cannot be diagnosed — the 5.9s block in muse's grade-school run
      // (2026-09-17) had nothing to go on. Profiles land in <data>/logs.
      LAX_LOOP_SENTINEL_PROFILE_MS: process.env.LAX_LOOP_SENTINEL_PROFILE_MS ?? "4000",
    },
  });
  const capture = (chunk) => {
    for (const line of chunk.toString().split("\n")) {
      if (!line.trim()) continue;
      tail.push(line);
      if (tail.length > logLines) tail.shift();
    }
  };
  child.stdout.on("data", capture);
  child.stderr.on("data", capture);

  const baseUrl = `http://127.0.0.1:${port}`;
  const headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
  const server = {
    root, roots: [root, workspaceRoot], dataDir, workspace, baseUrl, headers, logTail: () => tail.join("\n"),
    /** Non-null once the server process is gone. A server that ends ITSELF
     *  mid-run (the probe self-destruct did exactly this for months) makes
     *  every later observation meaningless — the caller must not grade it. */
    exitedOnItsOwn: () => (child.exitCode === null && child.signalCode === null ? null : { code: child.exitCode, signal: child.signalCode }),
    async api(method, path, body) {
      const res = await fetch(`${baseUrl}${path}`, { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
      if (!res.ok) throw new Error(`${method} ${path} → HTTP ${res.status}`);
      return res.json();
    },
    async stop() {
      if (child.exitCode === null) {
        const exited = new Promise((resolve) => child.once("exit", resolve));
        killProcessTree(child, "SIGTERM");
        await Promise.race([exited, new Promise((r) => setTimeout(r, 8_000))]);
        if (child.exitCode === null) killProcessTree(child, "SIGKILL");
      }
    },
    cleanup() {
      for (const dir of [root, workspaceRoot]) {
        try { rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 }); } catch { /* temp dir; best effort */ }
      }
    },
  };

  const deadline = Date.now() + BOOT_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`isolated server exited during boot (code ${child.exitCode})\n${server.logTail()}`);
    try {
      const res = await fetch(`${baseUrl}/api/health`, { headers, signal: AbortSignal.timeout(2_000) });
      if (res.ok) return server;
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 500));
  }
  await server.stop();
  throw new Error(`isolated server did not become healthy within ${BOOT_TIMEOUT_MS / 1000}s\n${server.logTail()}`);
}

