/**
 * Autonomous executor — runs an Operation's phases end-to-end without
 * requiring the chat agent to manually call operation_next / operation_advance.
 *
 * Lifecycle:
 *   operation_start → create op → startExecutor(op) returns immediately
 *   Executor loop (background):
 *     1. Get next pending phase
 *     2. Spawn a sub-agent via Handler with the phase prompt + suggested tools
 *     3. Wait for sub-agent result (handler:agent-result EventBus)
 *     4. Parse result → call markPhaseCompleted OR markPhaseFailed
 *     5. Loop until operation is completed / failed / paused / cancelled
 *
 * The chat agent never loops operation_next/advance — it just watches progress
 * via operation_status (or the UI sidebar). This eliminates the "agent forgets
 * to chain calls" class of bug entirely.
 */
import { join } from "node:path";
import type { Operation } from "./types.js";
import {
  loadOperation, writeOperation, nextPhase, buildPhasePrompt,
  markPhaseStarted, markPhaseCompleted, markPhaseFailed,
  pauseOperation, addEvent, appendPhaseLog,
} from "./conductor.js";

/** Running executor handles — one per active operation. Used for cancel. */
const activeExecutors = new Map<string, AbortController>();

export interface ExecutorOptions {
  workspaceDir?: string;
  /** Session ID of the user's chat — used so sub-agents inherit context & the
   *  approval gate routes back to the right UI. */
  parentSessionId?: string;
  /** Max concurrent phases. Default 1 (strictly sequential). */
  concurrency?: number;
}

/**
 * Start the executor for an operation. Returns immediately — executor runs
 * in the background and updates operation state on disk.
 */
export function startExecutor(operationId: string, opts: ExecutorOptions = {}): void {
  const workspaceDir = opts.workspaceDir || join(process.cwd(), "workspace", "operations");
  // If already running, ignore
  if (activeExecutors.has(operationId)) return;

  const controller = new AbortController();
  activeExecutors.set(operationId, controller);

  // Fire-and-forget: run the loop, log errors, remove from map when done
  (async () => {
    try {
      await runExecutorLoop(operationId, workspaceDir, controller.signal, opts);
    } catch (e) {
      console.warn(`[op-executor] ${operationId} crashed:`, (e as Error).message);
      const op = loadOperation(workspaceDir, operationId);
      if (op && op.status !== "cancelled") {
        addEvent(op, "error", `Executor crashed: ${(e as Error).message}`);
        op.status = "failed";
        writeOperation(workspaceDir, op);
      }
    } finally {
      activeExecutors.delete(operationId);
    }
  })();
}

/** Cancel an active executor. */
export function cancelExecutor(operationId: string): boolean {
  const controller = activeExecutors.get(operationId);
  if (!controller) return false;
  controller.abort();
  activeExecutors.delete(operationId);
  return true;
}

/** True if executor is currently running for this operation. */
export function isExecutorActive(operationId: string): boolean {
  return activeExecutors.has(operationId);
}

// ── Internal loop ───────────────────────────────────────────────────────

async function runExecutorLoop(
  operationId: string,
  workspaceDir: string,
  signal: AbortSignal,
  opts: ExecutorOptions
): Promise<void> {
  // Safety cap — no operation should need more than 50 phase executions
  // (phases × retries). If we hit this, something's looping.
  const MAX_ITERATIONS = 50;
  let iterations = 0;

  while (iterations++ < MAX_ITERATIONS) {
    if (signal.aborted) return;

    const op = loadOperation(workspaceDir, operationId);
    if (!op) return;
    if (op.status === "completed" || op.status === "failed" || op.status === "cancelled" || op.status === "paused") {
      return;
    }

    const phase = nextPhase(op);
    if (!phase) {
      // All phases done — mark complete. (markPhaseCompleted already does
      // this on the last phase, but cover the edge case where we land here
      // without completing through that path.)
      op.status = "completed";
      op.completedAt = Date.now();
      addEvent(op, "done", "Operation complete");
      writeOperation(workspaceDir, op);
      return;
    }

    markPhaseStarted(workspaceDir, op, phase);
    appendPhaseLog(workspaceDir, op, phase, `spawn sub-agent attempt ${phase.attempts}`);

    let agentResult: string;
    try {
      agentResult = await spawnPhaseAgent(op, phase, opts);
    } catch (e) {
      const err = (e as Error).message;
      appendPhaseLog(workspaceDir, op, phase, `agent error: ${err}`);
      const reloaded = loadOperation(workspaceDir, operationId);
      if (!reloaded) return;
      const outcome = markPhaseFailed(workspaceDir, reloaded, phase, err);
      if (!outcome.willRetry) return; // operation marked failed
      continue; // retry phase
    }

    // Parse agent result for phase outcome
    const parsed = parsePhaseResult(agentResult);
    appendPhaseLog(workspaceDir, op, phase, `agent finished: outcome=${parsed.outcome}`);

    const reloaded = loadOperation(workspaceDir, operationId);
    if (!reloaded) return;
    const phaseAfter = reloaded.phases.find((p) => p.id === phase.id);
    if (!phaseAfter) return;

    if (parsed.outcome === "paused") {
      pauseOperation(workspaceDir, reloaded, parsed.reason || `Phase "${phaseAfter.name}" needs user input`);
      return;
    }
    if (parsed.outcome === "failed") {
      const outcome = markPhaseFailed(workspaceDir, reloaded, phaseAfter, parsed.error || "Sub-agent reported failure");
      if (!outcome.willRetry) return;
      continue;
    }
    // completed
    markPhaseCompleted(workspaceDir, reloaded, phaseAfter, parsed.output);
  }

  // Hit iteration cap
  const op = loadOperation(workspaceDir, operationId);
  if (op && op.status !== "completed") {
    addEvent(op, "error", `Executor hit ${MAX_ITERATIONS}-iteration cap — stopping`);
    op.status = "failed";
    writeOperation(workspaceDir, op);
  }
}

// ── Sub-agent spawning ──────────────────────────────────────────────────

async function spawnPhaseAgent(op: Operation, phase: { id: string; name: string; suggestedTools: string[] }, opts: ExecutorOptions): Promise<string> {
  const { Handler } = await import("../agency/handler.js");
  const { EventBus } = await import("../event-bus.js");
  const handler = Handler.getInstance();

  const prompt = buildPhasePrompt(op, op.phases.find((p) => p.id === phase.id)!);
  const scopedPrompt =
    prompt +
    `\n\n## REPORT FORMAT — REQUIRED\n` +
    `When you finish the work (or hit a blocker), your FINAL message must be exactly one line in this form:\n` +
    `  PHASE_RESULT: <completed|failed|paused> | <json of any durable outputs like {"url":"...","id":"..."}> | <short reason if failed/paused>\n` +
    `Example completed: PHASE_RESULT: completed | {"fastmail_domain_id":"6041735"} |\n` +
    `Example failed:    PHASE_RESULT: failed | {} | GoDaddy rejected DNS: record conflict\n` +
    `Example paused:    PHASE_RESULT: paused | {} | need GoDaddy 2FA from user\n` +
    `Use this exact prefix. Nothing else on that last line.`;

  return new Promise<string>((resolve, reject) => {
    // spawnAgent is wired to EventBus — when the run completes, it emits
    // "handler:agent-result" with { agentId, result, error }.
    const agentId = handler.spawnAgent({
      name: `op-phase-${phase.name.slice(0, 30)}`,
      role: "operator",
      task: scopedPrompt,
      parentSessionId: opts.parentSessionId,
    });

    const timeout = setTimeout(() => {
      EventBus.off("handler:agent-result", resultHandler);
      reject(new Error(`Phase "${phase.name}" exceeded 15-min timeout`));
    }, 15 * 60_000);

    const resultHandler = (data: unknown) => {
      const d = data as { agentId: string; result?: string; error?: string; chunk?: string };
      if (d.agentId !== agentId) return;
      if (d.chunk) return; // streaming chunks — wait for final
      clearTimeout(timeout);
      EventBus.off("handler:agent-result", resultHandler);
      if (d.error) { reject(new Error(d.error)); return; }
      resolve(d.result || "");
    };
    EventBus.on("handler:agent-result", resultHandler);
  });
}

// ── Result parsing ──────────────────────────────────────────────────────

interface ParsedPhaseResult {
  outcome: "completed" | "failed" | "paused";
  output?: Record<string, unknown>;
  error?: string;
  reason?: string;
}

function parsePhaseResult(agentResult: string): ParsedPhaseResult {
  // Look for the mandatory PHASE_RESULT: line anywhere in the text
  const line = agentResult.split(/\r?\n/).reverse().find((l) => /^\s*PHASE_RESULT\s*:/i.test(l));
  if (!line) {
    // Agent didn't format its output. Heuristic fallback:
    const lower = agentResult.toLowerCase();
    if (/\bblock(ed|er)\b|\bneed(s)? user\b|\b2fa\b|\bcaptcha\b|\blogin required\b/.test(lower)) {
      return { outcome: "paused", reason: "Agent reported a blocker (auto-detected)" };
    }
    if (/\bfail(ed|ure)?\b|\berror\b|\bcannot\b/.test(lower.slice(-500))) {
      return { outcome: "failed", error: "Agent finished without success marker" };
    }
    // Default to completed — the run ended cleanly
    return { outcome: "completed" };
  }

  const match = line.match(/PHASE_RESULT\s*:\s*(completed|failed|paused)\s*\|\s*([^|]*)\|\s*(.*)$/i);
  if (!match) return { outcome: "completed" }; // malformed; assume ok
  const outcome = match[1].toLowerCase() as "completed" | "failed" | "paused";
  let output: Record<string, unknown> | undefined;
  try {
    const jsonText = match[2].trim();
    if (jsonText && jsonText !== "{}") output = JSON.parse(jsonText);
  } catch { /* ignore */ }
  const tail = match[3].trim();
  if (outcome === "failed") return { outcome, output, error: tail || "unknown failure" };
  if (outcome === "paused") return { outcome, output, reason: tail || "paused without reason" };
  return { outcome, output };
}
