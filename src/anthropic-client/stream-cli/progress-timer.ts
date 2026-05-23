// Silence-detector for the cold-spawn CLI path. The CLI doesn't emit
// anything for the first ~2s of cold-start while it boots. If the model
// is also slow to first byte (long thinking, big prompt), the UI sits
// blank for 10s+. Log "Still waiting..." every 5s after a 10s grace so
// developers tailing the server log can see the process is alive and
// not hung. Cleared on first byte from the model.

import { createLogger } from "../../logger.js";

const logger = createLogger("anthropic-client.stream-cli.progress");

export interface ProgressTimer {
  /** Call when the first response byte from the model arrives. */
  stop(): void;
}

export function startProgressTimer(): ProgressTimer {
  let dotCount = 0;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let interval: ReturnType<typeof setInterval> | null = null;

  timer = setTimeout(() => {
    interval = setInterval(() => {
      dotCount++;
      logger.info(`[claude] Still waiting... (${10 + dotCount * 5}s)`);
    }, 5000);
  }, 10000);

  return {
    stop() {
      if (timer) { clearTimeout(timer); timer = null; }
      if (interval) { clearInterval(interval); interval = null; }
    },
  };
}
