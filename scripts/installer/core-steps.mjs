import { existsSync } from "node:fs";
import { join } from "node:path";
import { EMBED_MODEL } from "./contract.mjs";
import { runtimeNodeEnv } from "./process-tools.mjs";
import { runOllamaModelStep } from "./ollama-model-step.mjs";
import { mutateInstallerDataRoot } from "./data-root.mjs";
import { readDurableJson, writeDurableJson } from "./checkpoint.mjs";

export async function runCoreSteps(context) {
  await installDependencies(context);
  const ollamaModelReady = await runOllamaModelStep(context);
  scaffoldSettings(context, ollamaModelReady);
  await buildServer(context);
  await writeRuntimeConfig(context);
}

async function installDependencies({ reporter, processes, platform = process.platform, env = process.env }) {
  const logLevel = env.LAX_NPM_LOGLEVEL || "error";
  if (!reporter.step("npm", "npm ci (5-10 min on first install)")) return;
  reporter.log("Installing npm dependencies (npm ci — enforces the committed lockfile)…");
  const nodeEnvironment = runtimeNodeEnv(platform, env);
  const environmentOption = nodeEnvironment ? { env: nodeEnvironment } : {};
  let result = await processes.runStreaming("npm", ["ci", "--no-audit", "--no-fund", `--loglevel=${logLevel}`], environmentOption);
  if (result.status !== 0) {
    reporter.warn("npm ci failed (lockfile drift or peer conflict). Falling back to npm install --legacy-peer-deps…");
    result = await processes.runStreaming("npm", [
      "install", "--no-audit", "--no-fund", `--loglevel=${logLevel}`, "--legacy-peer-deps",
    ], environmentOption);
    if (result.status !== 0) {
      reporter.fail(platform === "win32"
        ? "npm install failed. If the errors above mention node-gyp or a C++ build, a native module had no prebuilt binary and needs VS Build Tools — install it from https://visualstudio.microsoft.com/downloads/ and re-run."
        : "npm install failed. See errors above.");
    }
  }
  reporter.log("Verifying native module ABI…");
  const rebuild = processes.run("npm", [
    "rebuild", "better-sqlite3", "--no-audit", "--no-fund", `--loglevel=${logLevel}`,
  ], environmentOption);
  if (rebuild.status !== 0) reporter.warn("npm rebuild better-sqlite3 returned non-zero; continuing");
  reporter.ok("npm dependencies installed");
  reporter.stepDone("npm");
}

function scaffoldSettings(context, ollamaModelReady) {
  const { reporter, dataDirectory } = context;
  if (!reporter.step("settings")) return;
  const laxDirectory = dataDirectory;
  const settingsFile = join(laxDirectory, "settings.json");
  mutateInstallerDataRoot(context, ["settings.json"], () => {
    if (!existsSync(settingsFile)) {
      const defaults = ollamaModelReady
        ? { temperature: 0.7, maxIterations: 160, embeddingProvider: "ollama", embeddingModel: EMBED_MODEL }
        : { temperature: 0.7, maxIterations: 160, embeddingProvider: "local" };
      writeDurableJson(settingsFile, defaults, { fault: context.installerDataRootFault });
      reporter.ok(`Seeded ${settingsFile}`);
    } else reporter.ok("Settings already present");
  });
  reporter.stepDone("settings");
}

async function buildServer({ reporter, processes }) {
  if (!reporter.step("build", "tsc + arikernel (1-2 min)")) return;
  reporter.log("Building server (npm run build)…");
  const result = await processes.runStreaming("npm", ["run", "build"]);
  if (result.status !== 0) reporter.fail("npm run build failed. Fix the build errors above before re-running install — the runtime refuses to boot when its security layer (AriKernel pre-dispatch gate) can't wire.");
  reporter.ok("Server build complete");
  reporter.stepDone("build");
}

async function writeRuntimeConfig(context) {
  const { reporter, dataDirectory } = context;
  if (!reporter.step("config")) return;
  const laxDirectory = dataDirectory;
  const { randomBytes } = await import("node:crypto");
  mutateInstallerDataRoot(context, ["config.json"], () => {
    const configFile = join(laxDirectory, "config.json");
    const config = readDurableJson(configFile, {}, { fault: context.installerDataRootFault });
    config.projectRoot = process.cwd();
    if (!config.authToken) {
      config.authToken = randomBytes(32).toString("hex");
    }
    writeDurableJson(configFile, config, { fault: context.installerDataRootFault });
    reporter.ok(`Wired ${configFile} → projectRoot=${config.projectRoot}, authToken=${config.authToken.slice(0, 4)}...${config.authToken.slice(-4)}`);
  });
  reporter.stepDone("config");
}
