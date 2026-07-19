import { RealQualificationDriver } from "./real-driver.js";
import { readQualificationConfig, runQualification } from "./run.js";
import type { QualificationDriver, QualificationScorecard } from "./types.js";

const USAGE = [
  "Real local qualification uses only owned temporary state and is opt-in.",
  "Usage:",
  "  LAX_REAL_LOCAL_MODEL=1",
  "  LAX_REAL_LOCAL_ENDPOINT=http://127.0.0.1:11434",
  "  LAX_REAL_LOCAL_MODEL_TAG=<already-installed-ollama-tag>",
  "  npm run qualify:local-model",
  "The runner never pulls, downloads, installs, or starts a model.",
].join("\n");

export interface QualificationConsole {
  log(message: string): void;
  error(message: string): void;
}

export interface QualificationCliDeps {
  createDriver?(endpoint: string, model: string): QualificationDriver;
  signalSource?: AbortController;
}

export function sanitizedScorecard(scorecard: QualificationScorecard): QualificationScorecard {
  return {
    ...scorecard,
    stages: scorecard.stages.map(({ name, ok, durationMs, failure }) => ({
      name,
      ok,
      durationMs,
      ...(failure ? { failure } : {}),
    })),
  };
}

export async function runQualificationCli(
  env: NodeJS.ProcessEnv,
  output: QualificationConsole,
  deps: QualificationCliDeps = {},
): Promise<number> {
  let config: { endpoint: string; model: string };
  try {
    config = readQualificationConfig(env);
  } catch {
    output.error(USAGE);
    return 2;
  }

  const controller = deps.signalSource ?? new AbortController();
  const abort = () => controller.abort();
  process.once("SIGINT", abort);
  process.once("SIGTERM", abort);
  try {
    let driver: QualificationDriver;
    try {
      driver = deps.createDriver?.(config.endpoint, config.model)
        ?? new RealQualificationDriver(config.endpoint, config.model);
    } catch {
      output.error("Local qualification could not initialize its isolated runner.");
      return 1;
    }
    const scorecard = await runQualification(driver, { signal: controller.signal });
    output.log(JSON.stringify(sanitizedScorecard(scorecard), null, 2));
    return scorecard.ok ? 0 : 1;
  } finally {
    process.removeListener("SIGINT", abort);
    process.removeListener("SIGTERM", abort);
  }
}
