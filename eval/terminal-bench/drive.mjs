#!/usr/bin/env node
// Runs one Terminal-Bench task with LAX, INSIDE the task's container. The
// Harbor agent (lax_agent.py) uploads the Linux bundle and calls this from the
// task's working directory:
//
//   node eval/terminal-bench/drive.mjs --model lmstudio/qwen3.6-27b \
//     --instruction-file /installed-agent/instruction.txt \
//     --out /logs/agent/lax-result.json --server-log /logs/agent/lax-server.log
//
// `--mode code` (or LAX_TB_MODE=code on the host, which lax_agent.py forwards)
// opens the turn as a code session (src/session/mode.ts): the coding prompt and
// tool kit, as a coding task gets in the product. Unset, it is a chat.
//
// It boots a headless LAX server on a fresh data dir with the task's working
// directory as the workspace, sends the instruction as ONE chat turn (the way
// a user types it), waits for the turn to end, and stops the server. Harbor
// then runs the task's tests; the reply is recorded, never scored.
//
// Not startIsolatedServer (eval/op-outcomes/isolated.mjs): that one checks
// dist/ against a git checkout and reads the host user's credential file, and
// a task container has neither.
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { cpSync, createWriteStream, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { driveChat } from "../grok-coding-parity/lib.mjs";
import { SERVER_ENV, buildSeed, writeSeed } from "./seed.mjs";

const BOOT_TIMEOUT_MS = 180_000;
// Harbor enforces each task's own agent timeout; this only has to outlast it.
const DEFAULT_TURN_TIMEOUT_MS = 4 * 60 * 60_000;

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : fallback;
}

function freePort() {
  return new Promise((ok, fail) => {
    const srv = createServer();
    srv.once("error", fail);
    srv.listen(0, "127.0.0.1", () => { const { port } = srv.address(); srv.close(() => ok(port)); });
  });
}

async function waitHealthy(baseUrl, headers, child) {
  const deadline = Date.now() + BOOT_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) return `server exited during boot (code ${child.exitCode})`;
    try {
      const res = await fetch(`${baseUrl}/api/health`, { headers, signal: AbortSignal.timeout(2_000) });
      if (res.ok) return null;
    } catch { /* not listening yet */ }
    await new Promise((r) => setTimeout(r, 500));
  }
  return `server not healthy within ${BOOT_TIMEOUT_MS / 1000}s`;
}

async function stopServer(child) {
  if (child.exitCode !== null) return;
  const exited = new Promise((r) => child.once("exit", r));
  child.kill("SIGTERM");
  await Promise.race([exited, new Promise((r) => setTimeout(r, 8_000))]);
  if (child.exitCode === null) child.kill("SIGKILL");
}

async function main() {
  const modelName = arg("model");
  const instructionFile = arg("instruction-file");
  const outPath = arg("out", "lax-result.json");
  const serverLog = arg("server-log", "lax-server.log");
  // Unset: the runtime's default address for the model's prefix (seed.mjs).
  const localUrl = arg("local-url", process.env.LAX_TB_LOCAL_URL || undefined);
  const timeoutMs = Number(arg("timeout-ms", DEFAULT_TURN_TIMEOUT_MS));
  const mode = arg("mode", process.env.LAX_TB_MODE || "chat") === "code" ? "code" : "chat";
  if (!modelName || !instructionFile) {
    console.error("usage: drive.mjs --model <provider>/<model> --instruction-file <path> [--out <json>] [--server-log <path>]");
    process.exit(2);
  }
  const instruction = readFileSync(instructionFile, "utf8");
  const seed = buildSeed({ modelName, localUrl });

  const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
  const workspace = process.cwd();
  const dataDir = mkdtempSync(join(tmpdir(), "lax-tb-data-"));
  writeSeed(dataDir, seed);

  const port = await freePort();
  const token = randomBytes(24).toString("hex");
  const baseUrl = `http://127.0.0.1:${port}`;
  const headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
  mkdirSync(dirname(resolve(serverLog)), { recursive: true });
  const log = createWriteStream(serverLog, { flags: "a" });
  const child = spawn(process.execPath, ["--max-old-space-size=4096", "dist/index.js"], {
    cwd: repoRoot,
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      ...SERVER_ENV,
      LAX_DATA_DIR: dataDir,
      LAX_WORKSPACE: workspace,
      LAX_PORT: String(port),
      LAX_AUTH_TOKEN: token,
      LAX_BROWSER_HEADLESS: "1",
      // The bundle's node_modules are rebuilt for Linux, so its file hashes
      // differ from the Windows build's integrity manifest.
      LAX_INTEGRITY_WARN_ONLY: "1",
    },
  });
  child.stdout.pipe(log, { end: false });
  child.stderr.pipe(log, { end: false });

  const result = { model: modelName, mode, workspace, startedAt: new Date().toISOString() };
  let exitCode = 0;
  try {
    const bootError = await waitHealthy(baseUrl, headers, child);
    if (bootError) {
      result.harnessError = bootError;
      exitCode = 3;
    } else {
      const sessionId = `tb-${randomBytes(6).toString("hex")}`;
      const turn = await driveChat(instruction, sessionId, timeoutMs, { baseUrl, headers }, { mode: mode === "code" ? "code" : undefined });
      Object.assign(result, { sessionId, secs: turn.secs, toolCalls: turn.tools.length, tools: turn.tools, err: turn.err || null, recovered: turn.recovered, reply: turn.text });
    }
  } finally {
    await stopServer(child);
    log.end();
    result.endedAt = new Date().toISOString();
    mkdirSync(dirname(resolve(outPath)), { recursive: true });
    writeFileSync(outPath, JSON.stringify(result, null, 2));
    // The data dir holds the op's forensics (operations/, logs/, audit) and
    // lives in the container's /tmp, which goes away with the container. A
    // copy beside the result comes back with the trial's logs.
    try {
      cpSync(dataDir, join(dirname(resolve(outPath)), "lax-data"), { recursive: true });
    } catch (e) {
      console.error(`could not copy the data dir: ${e.message}`);
    }
  }
  console.log(JSON.stringify({ secs: result.secs, toolCalls: result.toolCalls, err: result.err, harnessError: result.harnessError }));
  process.exit(exitCode);
}

main().catch((e) => { console.error(e?.stack || String(e)); process.exit(1); });
