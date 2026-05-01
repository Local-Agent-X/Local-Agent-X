/**
 * runAutopilotLoop — orchestrates rounds for an autopilot Operation.
 *
 * Owns its own loop. Does NOT call startExecutor (the conductor's executor
 * is for pre-decomposed phase work, not dynamic round-style autopilot).
 * Reuses Operation only for persistence + events + status.
 */

import { writeFileSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import type { Operation } from "../operations/types.js";
import type { AutopilotState, RoundResult } from "./types.js";
import { runAutopilotRound } from "./round-agent.js";
import { validateRound, partitionByScope } from "./validate.js";
import { commitRound } from "./commit.js";
import { buildRunSummary, renderSummaryMarkdown } from "./summary.js";
import { releaseLock } from "./lock.js";
import type { StartAutopilotDeps } from "./start.js";

import { createLogger } from "../logger.js";
const logger = createLogger("autopilot.loop");

// ── Sidebar broadcast helpers ─────────────────────────────────────────────
//
// Autopilot ops were previously invisible to the AGENTS sidebar — they ran
// for hours emitting nothing the user could watch. The worker pool's
// session-bridge handles bg_op_* events for op_* IDs, but autopilot uses
// op_ap_* IDs and runs its own loop, bypassing that bridge entirely.
// These helpers wire autopilot directly into broadcastAll so the sidebar
// card surfaces start / per-round progress / completion in real time.

// Autopilot ops aren't tied to a single chat session — pass null so the
// envelope matches the worker pool's bg_op_* broadcast shape that chat.js
// expects: { type: "event", sessionId, event: { type: "bg_op_*", ... } }.
// Earlier I was sending { type: "bg_op_*", ... } at the top level, which
// chat.js silently dropped because it checks msg.event.type, not msg.type.
async function broadcast(event: Record<string, unknown>): Promise<void> {
  try {
    const { broadcastAll } = await import("../chat-ws.js");
    // chat.js requires sessionId TRUTHY (`if (msg.type === 'event' && msg.sessionId && msg.event)`).
    // null is falsy so it'd skip the whole bg_op handler block. Use "autopilot"
    // as a sentinel session id — chat.js doesn't route bg_op_* per-session
    // anyway (sidebar is global).
    broadcastAll({ type: "event", sessionId: "autopilot", event });
  } catch (e) {
    logger.warn(`[autopilot.loop] broadcast threw: ${(e as Error).message}`);
  }
}

async function broadcastStarted(opId: string, topic: string): Promise<void> {
  await broadcast({ type: "bg_op_started", opId, task: topic, provider: "autopilot" });
}

async function broadcastProgress(opId: string, line: string): Promise<void> {
  await broadcast({ type: "bg_op_progress", opId, line });
}

async function broadcastCompleted(opId: string, summary: string, ok: boolean): Promise<void> {
  await broadcast({ type: "bg_op_completed", opId, status: ok ? "completed" : "failed", summary });
}

// ── Stop signal registry ──────────────────────────────────────────────────
//
// POST /api/autopilot/stop/:id sets the flag. Loop checks at top of each
// round. v1 = "finish current round, then stop". v2 will add Kill (immediate
// AbortSignal + subprocess teardown).

const stopRequested = new Set<string>();

export function requestStop(opId: string): boolean {
  if (!stopRequested.has(opId)) {
    stopRequested.add(opId);
    logger.info(`[autopilot.loop] stop requested for ${opId}`);
    return true;
  }
  return false;
}

export function isStopRequested(opId: string): boolean {
  return stopRequested.has(opId);
}

function clearStopRequest(opId: string): void {
  stopRequested.delete(opId);
}

// ── Active operations registry (for status endpoint) ──────────────────────

const activeOps = new Map<string, Operation>();

export function getActiveAutopilotOp(opId: string): Operation | null {
  return activeOps.get(opId) || null;
}

export function listActiveAutopilotOps(): Operation[] {
  return [...activeOps.values()];
}

// ── Main loop ─────────────────────────────────────────────────────────────

export async function runAutopilotLoop(op: Operation, deps: StartAutopilotDeps): Promise<void> {
  const config = op.autopilot;
  if (!config) {
    logger.error(`[autopilot.loop] op ${op.id} has no autopilot config — refusing to run`);
    return;
  }

  activeOps.set(op.id, op);
  const startedAtIso = new Date().toISOString();
  const startMs = Date.now();
  const deadline = startMs + config.durationMs;

  // Surface the autopilot card in the AGENTS sidebar immediately. Any
  // connected browser tab gets a live "Autopilot: <topic>" tile to watch.
  void broadcastStarted(op.id, config.topic);

  let round = 0;
  let noopRoundsInARow = 0;
  let totalSelfEditCalls = 0;
  let lastRound: { outcome: string; summary: string; buildError?: string } | undefined;

  let finalState: AutopilotState = "running";

  try {
    while (true) {
      // Top-of-loop exit checks
      if (isStopRequested(op.id)) {
        logger.info(`[autopilot.loop] op ${op.id} interrupted by user`);
        finalState = "interrupted";
        break;
      }
      if (Date.now() >= deadline) {
        logger.info(`[autopilot.loop] op ${op.id} hit time deadline`);
        finalState = "deadline";
        break;
      }
      if (round >= config.maxRounds) {
        logger.info(`[autopilot.loop] op ${op.id} hit max-rounds (${config.maxRounds})`);
        finalState = "max-rounds";
        break;
      }
      if (noopRoundsInARow >= config.maxNoopRounds) {
        logger.info(`[autopilot.loop] op ${op.id} hit max-noop-rounds (${config.maxNoopRounds})`);
        finalState = "no-progress";
        break;
      }

      round++;
      const roundStartIso = new Date().toISOString();
      const roundStartMs = Date.now();
      const timeRemainingMs = Math.max(0, deadline - roundStartMs);

      addOpEvent(op, "progress", `Round ${round} starting (${Math.round(timeRemainingMs / 60_000)} min left)`);
      persistOp(op, deps.workspaceDir);
      void broadcastProgress(op.id, `▶ Round ${round} starting (${Math.round(timeRemainingMs / 60_000)} min budget left)`);

      // Bound the round agent by the remaining time budget. Without this,
      // a thrashing agent (e.g. tool retry loop) could run far past the
      // deadline because the deadline check only fires at top-of-loop.
      // Add a 30s buffer so the loop's own validation/commit gates don't
      // get cut off when the agent hands back near-instant.
      const roundBudgetMs = Math.max(60_000, timeRemainingMs - 30_000);
      const roundAbort = new AbortController();
      const roundDeadlineTimer = setTimeout(() => {
        logger.warn(`[autopilot.loop] round ${round} hit deadline (${Math.round(roundBudgetMs / 1000)}s) — aborting agent`);
        roundAbort.abort();
      }, roundBudgetMs);

      // Spawn the round agent
      let agentResult;
      try {
        agentResult = await runAutopilotRound(
          {
            config: deps.config,
            apiKey: deps.apiKey,
            model: deps.model,
            provider: deps.provider,
            allTools: deps.allTools,
          },
          {
            opId: op.id,
            autopilot: config,
            round,
            timeRemainingMs,
            roundsCompleted: round - 1,
            selfEditUsed: totalSelfEditCalls,
            lastRound,
            signal: roundAbort.signal,
          },
        );
        clearTimeout(roundDeadlineTimer);
      } catch (e) {
        clearTimeout(roundDeadlineTimer);
        const errMsg = (e as Error).message;
        logger.error(`[autopilot.loop] round ${round} agent error: ${errMsg}`);
        const result: RoundResult = {
          round,
          outcome: "agent-error",
          summary: `Agent crashed: ${errMsg}`,
          filesChanged: [],
          filesInScope: [],
          filesOutOfScope: [],
          commitSha: null,
          durationMs: Date.now() - roundStartMs,
          startedAt: roundStartIso,
        };
        appendRound(op, result, deps.workspaceDir);
        lastRound = { outcome: "agent-error", summary: result.summary };
        // Don't increment noop counter — agent error is a different failure mode.
        // Just continue to next round; if it keeps failing, max-rounds will stop it.
        continue;
      }

      totalSelfEditCalls += agentResult.selfEditCallsThisRound;

      // AUTOPILOT_DONE check — clean exit
      if (agentResult.autopilotDone) {
        logger.info(`[autopilot.loop] op ${op.id} agent self-terminated: ${agentResult.doneReason}`);
        // Validate + commit any final changes from this round before stopping
        const validation = validateRound(config.worktreeName, config);
        const partitioned = partitionByScope(validation.filesChanged, config.scope);
        let commitSha: string | null = null;
        if (validation.outcome === "passed") {
          commitSha = commitRound({
            worktreeName: config.worktreeName,
            round,
            topic: config.topic,
            agentSummary: extractAgentSummary(agentResult.output),
          });
        }
        const result: RoundResult = {
          round,
          outcome: validation.outcome,
          summary: agentResult.doneReason || extractAgentSummary(agentResult.output),
          filesChanged: validation.filesChanged,
          filesInScope: partitioned.inScope,
          filesOutOfScope: partitioned.outOfScope,
          commitSha,
          durationMs: Date.now() - roundStartMs,
          startedAt: roundStartIso,
        };
        appendRound(op, result, deps.workspaceDir);
        finalState = "completed";
        break;
      }

      // Validate
      const validation = validateRound(config.worktreeName, config);
      const partitioned = partitionByScope(validation.filesChanged, config.scope);
      const agentSummary = extractAgentSummary(agentResult.output);

      let commitSha: string | null = null;
      if (validation.outcome === "passed") {
        commitSha = commitRound({
          worktreeName: config.worktreeName,
          round,
          topic: config.topic,
          agentSummary,
        });
        noopRoundsInARow = 0;
        addOpEvent(op, "progress", `Round ${round} passed (${commitSha?.slice(0, 8) || "no-sha"}, ${validation.filesChanged.length} files)`);
        void broadcastProgress(op.id, `✓ Round ${round} passed — ${validation.filesChanged.length} file${validation.filesChanged.length === 1 ? "" : "s"}, commit ${commitSha?.slice(0, 8) || "no-sha"}`);
      } else if (validation.outcome === "noop") {
        noopRoundsInARow++;
        addOpEvent(op, "info", `Round ${round} no-op (${noopRoundsInARow}/${config.maxNoopRounds})`);
        void broadcastProgress(op.id, `⏭ Round ${round} no-op (${noopRoundsInARow}/${config.maxNoopRounds})`);
      } else {
        // failed-build / failed-size / failed-test — already reverted
        addOpEvent(op, "error", `Round ${round} ${validation.outcome}: ${validation.detail.slice(0, 200)}`);
        void broadcastProgress(op.id, `✗ Round ${round} ${validation.outcome}: ${validation.detail.slice(0, 100)}`);
      }

      const result: RoundResult = {
        round,
        outcome: validation.outcome,
        summary: agentSummary || `(no summary; outcome=${validation.outcome})`,
        filesChanged: validation.filesChanged,
        filesInScope: partitioned.inScope,
        filesOutOfScope: partitioned.outOfScope,
        commitSha,
        durationMs: Date.now() - roundStartMs,
        startedAt: roundStartIso,
      };
      appendRound(op, result, deps.workspaceDir);

      lastRound = {
        outcome: validation.outcome,
        summary: agentSummary,
        buildError: validation.outcome === "failed-build" ? validation.detail : undefined,
      };
    }
  } catch (e) {
    logger.error(`[autopilot.loop] op ${op.id} fatal: ${(e as Error).message}`);
    finalState = "error";
    addOpEvent(op, "error", `Loop crashed: ${(e as Error).message}`);
  } finally {
    // Build summary, persist, update Operation status
    const summary = buildRunSummary({
      opId: op.id,
      state: finalState,
      config,
      rounds: op.autopilotRounds || [],
      startedAt: startedAtIso,
      selfEditCalls: totalSelfEditCalls,
    });

    op.status = finalState === "error" ? "failed" : finalState === "interrupted" ? "cancelled" : "completed";
    op.completedAt = Date.now();
    addOpEvent(op, "done", renderSummaryMarkdown(summary));
    persistOp(op, deps.workspaceDir);

    // Sidebar: surface the final state. The card flips from "working" to
    // completed/failed/cancelled and shows the one-line summary so the user
    // can see at a glance how the run ended without opening the report.
    const completedRounds = (op.autopilotRounds || []).length;
    const passedRounds = (op.autopilotRounds || []).filter(r => r.outcome === "passed").length;
    void broadcastCompleted(
      op.id,
      `${finalState} — ${completedRounds} rounds, ${passedRounds} passed${totalSelfEditCalls > 0 ? `, ${totalSelfEditCalls} self_edit calls` : ""}`,
      op.status === "completed",
    );

    // Persist a summary file alongside operation.json for easy review
    try {
      const opDir = join(deps.workspaceDir, op.id);
      writeFileSync(join(opDir, "summary.json"), JSON.stringify(summary, null, 2), "utf-8");
      writeFileSync(join(opDir, "summary.md"), renderSummaryMarkdown(summary), "utf-8");
    } catch (e) {
      logger.warn(`[autopilot.loop] failed to write summary files: ${(e as Error).message}`);
    }

    activeOps.delete(op.id);
    clearStopRequest(op.id);
    releaseLock(op.id);

    logger.info(`[autopilot.loop] op ${op.id} done: state=${finalState}, rounds=${(op.autopilotRounds || []).length}`);
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────

function appendRound(op: Operation, round: RoundResult, workspaceDir: string): void {
  if (!op.autopilotRounds) op.autopilotRounds = [];
  op.autopilotRounds.push(round);
  persistOp(op, workspaceDir);
}

function addOpEvent(op: Operation, level: Operation["events"][number]["level"], message: string): void {
  op.events.push({ ts: Date.now(), level, message });
  // Cap event log to last 200 to bound memory.
  if (op.events.length > 200) op.events = op.events.slice(-200);
}

function persistOp(op: Operation, workspaceDir: string): void {
  try {
    const opDir = join(workspaceDir, op.id);
    if (!existsSync(opDir)) return;
    const file = join(opDir, "operation.json");
    writeFileSync(file, JSON.stringify(op, null, 2), "utf-8");
  } catch (e) {
    logger.warn(`[autopilot.loop] persist failed: ${(e as Error).message}`);
  }
}

/** Pull a one-line summary from the agent's output. Skips the AUTOPILOT_DONE line. */
function extractAgentSummary(output: string): string {
  if (!output) return "";
  const lines = output.split("\n").map(l => l.trim()).filter(Boolean);
  // Prefer the first non-AUTOPILOT_DONE line.
  for (const line of lines) {
    if (line.startsWith("AUTOPILOT_DONE:")) continue;
    return line.slice(0, 280);
  }
  return lines[0]?.slice(0, 280) || "";
}

// Touch readFileSync to silence unused-import warning if loadOperation refactored later.
void readFileSync;
