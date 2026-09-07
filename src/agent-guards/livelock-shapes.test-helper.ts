/**
 * The real turn-by-turn tool shape of op_chat_turn_4808572060514f75 (turns
 * 39-119 of a 160-turn chat op that livelocked): the agent rebuilt a scratch
 * harness, screenshotted it, re-fetched two unchanged prod URLs, and started
 * over — twelve times, learning nothing, renaming its scratch file each lap.
 * Every detector in the guard missed it at the time. Synthetic loops are easy
 * to catch; this is the shape a real model actually produces, jitter included.
 *
 * Shared by the guard-level suite (agent-guards/loop-progress.test.ts) and the
 * middleware-level replay (canonical-loop/middlewares/loop-detection.livelock
 * .test.ts) so both lanes are judged against the SAME recorded run. Lives
 * under src/ (not test/) because tsconfig's rootDir is src.
 */
export const LIVELOCK_SHAPES: readonly string[] = [
  "http_request,http_request", "write", "write", "browser", "browser", "browser", "browser",
  "http_request,http_request", "http_request,http_request", "write", "write", "browser", "browser",
  "http_request,http_request", "write", "write", "browser", "browser", "browser", "bash",
  "delete_file", "http_request", "http_request", "write", "write", "browser", "browser",
  "http_request,http_request", "write", "write", "browser", "browser", "http_request,http_request",
  "browser", "browser", "browser", "browser", "browser", "http_request,http_request", "write",
  "write", "browser", "browser", "browser", "http_request,http_request", "write", "write",
  "browser", "browser", "http_request,http_request", "write", "write", "browser", "browser",
  "http_request,http_request", "write", "write", "browser", "browser", "http_request,http_request",
  "write", "write", "browser", "browser", "http_request,http_request", "write", "write",
  "browser", "browser", "browser", "http_request,http_request", "write", "write", "browser",
  "browser", "browser", "http_request,http_request",
];
