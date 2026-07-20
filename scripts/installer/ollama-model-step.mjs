import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { EMBED_MODEL } from "./contract.mjs";
import { ensureOllamaOnPath, killOllamaServe } from "./windows-tools.mjs";

const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

export async function runOllamaModelStep(context, { createReadiness: readinessFactory = createReadiness } = {}) {
  const { reporter, processes, wantOllamaMemoryModel } = context;
  reporter.step("embedmodel", wantOllamaMemoryModel ? `Downloading ${EMBED_MODEL} (~670 MB, one-time)` : "Using built-in local embedder");
  if (!wantOllamaMemoryModel) {
    reporter.ok(`Local embedder ready — no download needed. Enable Ollama later for stronger semantic memory: install Ollama, run \`ollama pull ${EMBED_MODEL}\`, then set Embedding Provider to Ollama in Settings.`);
    reporter.stepDone("embedmodel");
    return false;
  }
  ensureOllamaOnPath();
  if (!processes.has("ollama")) {
    reporter.fail(`Ollama not on PATH — the requested memory model was not downloaded. Install Ollama and re-run, or run: ollama pull ${EMBED_MODEL}`);
    return false;
  }
  const readiness = readinessFactory(context);
  if (!(await readiness.ensureUp())) {
    reporter.fail(`Ollama daemon didn't come up at ${readiness.url} — the requested memory model was not downloaded. Re-run later: ollama pull ${EMBED_MODEL}`);
    return false;
  }
  reporter.log(`Pulling ${EMBED_MODEL} (~670MB, one-time)…`);
  let pull = await processes.runStreaming("ollama", ["pull", EMBED_MODEL]);
  if (pull.status !== 0) {
    reporter.warn("Pull failed on first attempt — restarting daemon and retrying once…");
    killOllamaServe(processes);
    await delay(2000);
    processes.spawn("ollama", ["serve"], { detached: true, stdio: "ignore" }).unref();
    const deadline = Date.now() + 30000;
    while (Date.now() < deadline) {
      await delay(1000);
      if (await readiness.ready()) break;
    }
    pull = await processes.runStreaming("ollama", ["pull", EMBED_MODEL]);
  }
  if (pull.status === 0) {
    reporter.ok("Memory engine ready");
    reporter.stepDone("embedmodel");
    return true;
  }
  reporter.fail(`Pull failed twice — the requested memory model was not downloaded. Re-run later: ollama pull ${EMBED_MODEL}`);
  return false;
}

function createReadiness({ reporter, processes, env = process.env }) {
  const url = env.LAX_OLLAMA_URL || "http://127.0.0.1:11434";
  const keypair = join(homedir(), ".ollama", "id_ed25519");
  const tagsResponding = async () => {
    try {
      const response = await fetch(`${url}/api/tags`, { signal: AbortSignal.timeout(2000) });
      return response.ok;
    } catch { return false; }
  };
  const ready = async () => (await tagsResponding()) && existsSync(keypair);
  const ensureUp = async () => {
    if (await ready()) return true;
    if (await tagsResponding()) {
      reporter.log("Ollama daemon up but keypair missing — restarting to reinitialize…");
      killOllamaServe(processes);
      await delay(1500);
    } else reporter.log("Starting Ollama daemon…");
    const daemon = processes.spawn("ollama", ["serve"], { detached: true, stdio: "ignore" });
    daemon.unref();
    const deadline = Date.now() + 30000;
    while (Date.now() < deadline) {
      await delay(1000);
      if (await ready()) return true;
    }
    return false;
  };
  return { url, ready, ensureUp };
}
