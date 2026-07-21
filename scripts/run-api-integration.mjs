#!/usr/bin/env node
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:net";
import { missingReleasePrerequisites } from "./check-release-environment.mjs";
import { terminateProcessTree } from "./release-process-tree.mjs";

const missing = missingReleasePrerequisites();
if (missing.length) {
  console.error(`test:integration prerequisites missing: ${missing.join(", ")}`);
  process.exit(2);
}

const dataDir = mkdtempSync(join(tmpdir(), "lax-release-integration-"));
let server;
let logs = "";

function freePort() {
  return new Promise((resolve, reject) => {
    const socket = createServer();
    socket.once("error", reject);
    socket.listen(0, "127.0.0.1", () => {
      const address = socket.address();
      socket.close((error) => error ? reject(error) : resolve(address.port));
    });
  });
}

function appendLog(chunk) {
  logs = `${logs}${chunk.toString("utf8")}`.slice(-8_000);
}

async function waitForServer(url, configPath) {
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    if (server.exitCode !== null) throw new Error("server exited during integration boot");
    try {
      const response = await fetch(`${url}/api/health`, { signal: AbortSignal.timeout(1_000) });
      if (response.ok && existsSync(configPath)) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error("server did not become ready for integration tests");
}

async function stopServer() {
  if (!server || server.exitCode !== null) return;
  await terminateProcessTree(server, 5_000);
}

function runTests(env) {
  return new Promise((resolve) => {
    const tests = spawn(process.execPath, ["--import=tsx", "src/test-suite.ts"], {
      env, windowsHide: true, detached: process.platform !== "win32", stdio: "inherit",
    });
    let timedOut = false;
    const timer = setTimeout(async () => {
      timedOut = true;
      await terminateProcessTree(tests);
    }, 10 * 60_000);
    tests.once("error", (error) => {
      clearTimeout(timer);
      console.error(`test:integration could not start: ${error.message}`);
      resolve(false);
    });
    tests.once("exit", (code) => {
      clearTimeout(timer);
      if (timedOut) console.error("test:integration timed out");
      resolve(!timedOut && code === 0);
    });
  });
}

let exitCode = 1;
try {
  const port = await freePort();
  const env = {
    ...process.env,
    LAX_DATA_DIR: dataDir,
    LAX_PORT: String(port),
    LAX_SANDBOX: "disabled",
    NODE_OPTIONS: "--max-old-space-size=4096",
  };
  server = spawn(process.execPath, ["--import=tsx", "src/index.ts"], {
    env, windowsHide: true, detached: process.platform !== "win32", stdio: ["ignore", "pipe", "pipe"],
  });
  server.stdout.on("data", appendLog);
  server.stderr.on("data", appendLog);
  await waitForServer(`http://127.0.0.1:${port}`, join(dataDir, "config.json"));
  exitCode = await runTests(env) ? 0 : 1;
} catch (error) {
  console.error(`test:integration failed: ${error?.message ?? error}`);
} finally {
  await stopServer();
  if (exitCode !== 0 && logs) console.error(`Server log tail:\n${logs}`);
  rmSync(dataDir, { recursive: true, force: true });
}
process.exit(exitCode);
