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

import { createLogger } from "../logger.js";
const logger = createLogger("operations.executor");

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
      logger.warn(`[op-executor] ${operationId} crashed:`, (e as Error).message);
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

/** Union of preBlessedSecrets across all currently-running operations. Used by
 *  browser_fill_from_secret to decide whether to skip the first-use approval
 *  gate. Origin-binding is enforced separately and is not overridden by this. */
export function getActivePreBlessedSecrets(
  loadOperationFn: (operationId: string) => { preBlessedSecrets?: string[] } | null
): Set<string> {
  const result = new Set<string>();
  for (const opId of activeExecutors.keys()) {
    const op = loadOperationFn(opId);
    if (op?.preBlessedSecrets) for (const name of op.preBlessedSecrets) result.add(name);
  }
  return result;
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
  const { invokeDefinition } = await import("../agents/invoke.js");
  const { EventBus } = await import("../event-bus.js");

  const phaseObj = op.phases.find((p) => p.id === phase.id)!;
  let prompt = buildPhasePrompt(op, phaseObj);

  // Inject live browser state if a prior phase left a tab open, so the sub-agent
  // picks up where we left off instead of navigating from scratch.
  const browserState = await captureBrowserState();
  if (browserState) prompt += `\n\n${browserState}`;

  // Scoped system prompt for sub-agent. Forces decisive action — the biggest
  // failure mode observed is sub-agents hitting snapshot → "I see an Edit
  // button" → ask user to click it. That's 5 turns wasted asking for a
  // click the agent can just make itself.
  const scopedSystemPrompt =
    `You are executing ONE phase of an autonomous operation. You have browser and API tools. The user is NOT watching — they gave you a goal and left. Your job is to finish the phase.\n\n` +
    `## BE DECISIVE — click your own buttons\n` +
    `If a snapshot shows an Edit / Manage / Add / Save / Continue / Next / Confirm button, CLICK IT. Do not ask the user. Do not say "please open the X page" — open it yourself with browser navigate/click. The user already told you what to do by stating the goal; carrying it out is YOUR job.\n\n` +
    `Only pause (PHASE_RESULT: paused) for genuine blockers the user MUST resolve:\n` +
    `  - 2FA code / SMS OTP / authenticator app\n` +
    `  - CAPTCHA\n` +
    `  - Payment method entry / credit card\n` +
    `  - A credential you don't have and can't find via Chrome autofill\n` +
    `NEVER pause for:\n` +
    `  - "I see the Edit button but didn't click it"  (CLICK IT)\n` +
    `  - "the DNS values aren't visible on this screen"  (click Edit / Manage to reveal them)\n` +
    `  - "I'd need another page open"  (navigate there yourself)\n` +
    `  - "I'm not sure which option to pick"  (pick the safest and try; you can undo)\n\n` +
    `## Browser is STATEFUL across phases\n` +
    `The browser session — including its element refs — persists from the previous phase. The first "browser snapshot" you run will either return a full element listing (new page) or a DIFF (same page as before: + added / - removed / ~ changed). Refs are durable: ref [5] from a prior phase still points to the same button if the element is still on the page. Before acting, always run snapshot to confirm what's there.\n\n` +
    `## MANDATORY tool routing\n` +
    `- Web / DNS / form / login / click → "browser" (navigate → snapshot → click/fill by ref)\n` +
    `- HTTP API with known URL → "http_request"\n` +
    `- Shell command → "bash"\n` +
    `- Files → "read" / "write" / "edit"\n` +
    `- Agent memory → "memory_search" (NOT grep)\n` +
    `- NO grep for web content, NO screen_capture for web pages\n\n` +
    `If the phase involves a website, your FIRST tool call is "browser" navigate to that URL.\n\n` +
    `## Report format — REQUIRED last line\n` +
    `Your FINAL message's last line must be exactly:\n` +
    `  PHASE_RESULT: <completed|failed|paused> | <json outputs> | <reason if failed/paused>\n` +
    `Examples:\n` +
    `  PHASE_RESULT: completed | {"fastmail_domain_id":"6041735","dns_records_added":7} |\n` +
    `  PHASE_RESULT: failed | {} | GoDaddy API rejected record: duplicate MX\n` +
    `  PHASE_RESULT: paused | {} | need user to enter 2FA code from authenticator\n`;

  return new Promise<string>((resolve, reject) => {
    // invokeDefinition routes the run through the canonical-loop driver and
    // emits handler:agent-result on terminal. The run is persisted to
    // ~/.lax/operations/<opId>/events.jsonl so a crash here is recoverable.
    const phaseName = phaseObj.name.slice(0, 30);
    const ref = invokeDefinition(
      {
        id: `inline-operator-${op.id}-${phaseObj.id}`,
        name: `op-phase-${phaseName}`,
        role: "operator",
        systemPrompt: scopedSystemPrompt,
        allowedTools: phaseObj.suggestedTools,
        description: "Inline operations executor phase agent.",
      },
      prompt,
      { parentSessionId: opts.parentSessionId },
    );
    const agentId = ref.runId;

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

// ── Browser state capture ────────────────────────────────────────────────

/**
 * If a prior phase left a browser page open, return a short summary so the
 * next sub-agent knows where it is. Returns null if no active page — the
 * next phase will navigate fresh.
 */
async function captureBrowserState(): Promise<string | null> {
  try {
    const { getBrowserManager } = await import("../browser.js");
    const mgr = getBrowserManager("default");
    if (!mgr.isActive()) return null;
    const info = await mgr.getInfo().catch(() => "");
    const tabs = await mgr.listTabs().catch(() => "");
    if (!info || info.includes("No browser session active")) return null;
    return `--- BROWSER STATE (carried over from previous phase) ---\n${info}\n\nOpen tabs:\n${tabs}\n\nIf this page is relevant to the current phase, call "browser snapshot" to see current refs (you'll get a diff since last observation). If not, navigate where you need to go.\n--- END BROWSER STATE ---`;
  } catch {
    return null;
  }
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
    // Default to FAILED when no PHASE_RESULT marker — previously this defaulted
    // to "completed" which let the executor silently advance through phases
    // where the sub-agent actually did nothing (end_turn after a few browser
    // calls). Failing triggers a retry with an explicit format reminder, which
    // is far better than chugging forward on imaginary progress.
    return { outcome: "failed", error: "Agent ended without PHASE_RESULT marker — phase incomplete" };
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
