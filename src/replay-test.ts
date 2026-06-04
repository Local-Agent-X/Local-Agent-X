/**
 * Deterministic replay tests.
 *
 * Loads recorded sessions from test/fixtures/recordings/*.json and replays
 * the structural assertions: every tool name in the recording still resolves,
 * arguments still parse, no tool result exceeded the budget, no infinite loop
 * patterns slipped through. This catches regressions where we rename a tool,
 * delete a flag, or break a security layer without realising recorded flows
 * would have died.
 *
 * This intentionally does NOT call any LLM. It is offline, deterministic,
 * and CI-safe. The fixtures are committed as plain JSON and easy to add to.
 *
 * Usage: tsx src/replay-test.ts
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { allTools } from "./tools.js";

import { createLogger } from "./logger.js";
const logger = createLogger("replay-test");

interface RecordedEvent {
  type: string;
  data?: Record<string, unknown>;
  timestamp?: number;
}

interface Recording {
  id?: string;
  sessionId?: string;
  startedAt?: number;
  duration?: number;
  metadata?: Record<string, unknown>;
  events: RecordedEvent[];
}

interface ReplayCheckResult {
  fixture: string;
  passed: boolean;
  failures: string[];
  toolsSeen: number;
  events: number;
}

const FIXTURES_DIR = resolve(process.cwd(), "test", "fixtures", "recordings");
const MAX_RESULT_SIZE = 50_000;
const LOOP_THRESHOLD = 12;

function loadFixtures(): { path: string; recording: Recording }[] {
  if (!existsSync(FIXTURES_DIR)) {
    logger.info(`[replay] No fixtures dir at ${FIXTURES_DIR} — nothing to replay.`);
    return [];
  }
  const files = readdirSync(FIXTURES_DIR).filter((f) => f.endsWith(".json"));
  const out: { path: string; recording: Recording }[] = [];
  for (const file of files) {
    const full = join(FIXTURES_DIR, file);
    try {
      const raw = readFileSync(full, "utf-8");
      const parsed = JSON.parse(raw) as Recording;
      if (!Array.isArray(parsed.events)) {
        logger.warn(`[replay] ${file}: skipping — no events array`);
        continue;
      }
      out.push({ path: full, recording: parsed });
    } catch (e) {
      logger.warn(`[replay] ${file}: failed to parse — ${(e as Error).message}`);
    }
  }
  return out;
}

function checkRecording(fixture: string, rec: Recording, knownTools: Set<string>): ReplayCheckResult {
  const failures: string[] = [];
  let toolsSeen = 0;
  const sameToolKey: Record<string, number> = {};

  for (const ev of rec.events) {
    if (ev.type === "tool_call") {
      toolsSeen += 1;
      const name = String(ev.data?.name || ev.data?.tool || "");
      const argsStr = typeof ev.data?.args === "string" ? ev.data.args : JSON.stringify(ev.data?.args ?? {});

      if (!name) {
        failures.push(`tool_call event has no name (events[${rec.events.indexOf(ev)}])`);
        continue;
      }
      if (!knownTools.has(name)) {
        failures.push(`tool "${name}" no longer registered (was used in recording)`);
      }

      try {
        if (argsStr) JSON.parse(argsStr);
      } catch {
        failures.push(`tool "${name}" args no longer parse as JSON: ${argsStr.slice(0, 80)}`);
      }

      const key = `${name}:${argsStr}`;
      sameToolKey[key] = (sameToolKey[key] || 0) + 1;
      if (sameToolKey[key] >= LOOP_THRESHOLD) {
        failures.push(`infinite-loop pattern detected: ${name} called ${sameToolKey[key]} times with identical args`);
      }
    }

    if (ev.type === "tool_result") {
      const result = String(ev.data?.result || "");
      if (result.length > MAX_RESULT_SIZE * 2) {
        failures.push(`tool_result exceeds 2x budget (${result.length} chars > ${MAX_RESULT_SIZE * 2})`);
      }
    }
  }

  return {
    fixture,
    passed: failures.length === 0,
    failures,
    toolsSeen,
    events: rec.events.length,
  };
}

async function main(): Promise<number> {
  const knownTools = new Set(allTools.map((t) => t.name));
  logger.info(`[replay] Known tools: ${knownTools.size}`);

  const fixtures = loadFixtures();
  if (fixtures.length === 0) {
    logger.info("[replay] No fixtures to check. Pass.");
    return 0;
  }

  let failed = 0;
  const results: ReplayCheckResult[] = [];

  for (const { path, recording } of fixtures) {
    const result = checkRecording(path, recording, knownTools);
    results.push(result);
    const status = result.passed ? "PASS" : "FAIL";
    logger.info(`[replay] ${status} ${path.split(/[\\/]/).pop()} (${result.toolsSeen} tool calls, ${result.events} events)`);
    if (!result.passed) {
      failed += 1;
      for (const f of result.failures) {
        logger.info(`         - ${f}`);
      }
    }
  }

  logger.info(`[replay] ${results.length - failed}/${results.length} fixtures passed`);
  return failed > 0 ? 1 : 0;
}

main().then((code) => process.exit(code)).catch((e) => {
  logger.error("[replay] fatal:", e);
  process.exit(2);
});
