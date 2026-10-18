// The fresh LAX data dir one Terminal-Bench task starts from. Pure: the
// in-container driver (drive.mjs) writes what this returns, and the seed test
// pins it without a container.
//
// Every task gets its own empty data dir, so nothing learned on one task
// (memory, protocols, skills) reaches the next one.
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

/** Where LM Studio's server is reached from inside a task container. */
export const DEFAULT_LOCAL_URL = "http://host.docker.internal:1234";

/**
 * Environment the server runs with. A chat sent over HTTP is an "api" call,
 * and unattended shell there needs a confining sandbox or the user's
 * acknowledgement of the unconfined host (src/sandbox/index.ts). LAX's
 * Linux cage (bubblewrap) cannot start inside a Docker container, so the run
 * selects the host mode explicitly and the seed acknowledges it, as a user
 * does in Settings > Security: the task container is the boundary.
 */
export const SERVER_ENV = { LAX_SANDBOX: "host" };

/** Harbor model prefixes LAX runs, mapped to the LAX provider id. */
const PROVIDER_BY_PREFIX = {
  lmstudio: "local",
  local: "local",
};

/**
 * Split a Harbor `-m` value (`lmstudio/qwen3.6-27b`) into LAX's provider and
 * model id. The model id keeps any further slashes (`local/org/model`).
 */
export function parseModel(modelName) {
  const slash = typeof modelName === "string" ? modelName.indexOf("/") : -1;
  if (slash <= 0 || slash === modelName.length - 1) {
    throw new Error(`model must be <provider>/<model>, got ${JSON.stringify(modelName)}`);
  }
  const prefix = modelName.slice(0, slash).toLowerCase();
  const provider = PROVIDER_BY_PREFIX[prefix];
  if (!provider) {
    throw new Error(`provider "${prefix}" is not supported yet; use one of: ${Object.keys(PROVIDER_BY_PREFIX).join(", ")}`);
  }
  return { provider, model: modelName.slice(slash + 1) };
}

/**
 * The files of a fresh data dir, keyed by path relative to it.
 *
 * - settings.json: the chat provider and model. A local model is reached
 *   through a hand-added runtime entry, the product's own way to name a
 *   non-loopback endpoint (src/local-runtimes/admission.ts admits it on an
 *   exact host:port match).
 * - autonomy-profile.json: Autonomous, because no one is there to answer an
 *   approval card.
 * - security.json: unrestricted file access. The task container is the
 *   boundary and is thrown away after the run; tasks install packages and
 *   edit files outside the working directory.
 * - sandbox-host-acknowledgement.json: the acknowledgement for SERVER_ENV's
 *   host mode (see above).
 * - memory/USER.md, memory/IDENTITY.md: a named user and agent, as the eval
 *   rigs seed (eval/op-outcomes/isolated.mjs), so the first reply is not the
 *   first-run identity ask.
 */
export function buildSeed({ modelName, localUrl = DEFAULT_LOCAL_URL, now = new Date() }) {
  const { provider, model } = parseModel(modelName);
  const settings = { provider, model };
  if (provider === "local") {
    settings.localRuntimes = [{ kind: "openai-compat", baseUrl: localUrl.replace(/\/+$/, ""), label: "LM Studio" }];
  }
  return {
    "settings.json": JSON.stringify(settings),
    "autonomy-profile.json": JSON.stringify({ profile: "Autonomous" }),
    "security.json": JSON.stringify({ fileAccessMode: "unrestricted" }),
    "sandbox-host-acknowledgement.json": JSON.stringify({ acknowledged: true, selectedMode: SERVER_ENV.LAX_SANDBOX, acknowledgedAt: now.toISOString() }),
    "memory/USER.md": "# About Me\n\n- Name: Sam\n",
    "memory/IDENTITY.md": "# Agent Identity\n\n- Name: Agent X\n",
  };
}

export function writeSeed(dataDir, seed) {
  for (const [rel, content] of Object.entries(seed)) {
    const path = join(dataDir, rel);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content);
  }
}
