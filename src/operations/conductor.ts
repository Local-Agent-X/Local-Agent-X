/**
 * Operation Conductor — orchestrates a long-horizon goal.
 *
 * Persists to disk so a crashed/paused operation can resume cleanly:
 *   workspace/operations/<id>/
 *     operation.json   — full Operation state (JSON)
 *     plan.md          — human-readable plan for inspection
 *     phase-<n>.log    — per-phase execution log (future: tool calls + outputs)
 *
 * The conductor itself doesn't execute tools — that's the agent's job. The
 * conductor picks the next phase, builds a scoped prompt for it, and records
 * the outcome. The actual tool-calling happens in the agent loop that gets
 * invoked with the phase-scoped prompt.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync, appendFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { randomBytes } from "node:crypto";
import type { Operation, OperationEvent, OperationPhase } from "./types.js";
import { getRuntimeConfig } from "../config.js";
import { decomposeGoal } from "./decomposer.js";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);

export interface ConductorOptions {
  /** Root where operation dirs live. Defaults to workspace/operations */
  workspaceDir?: string;
  /** Decomposer provider override */
  provider?: "ollama" | "anthropic" | "openai" | "auto";
  /** Decomposer model override */
  model?: string;
  /** Known protocol names to match phases against */
  knownProtocols?: string[];
  /** Secret names pre-blessed for automated fill during this operation */
  preBlessedSecrets?: string[];
}

const MAX_PHASE_ATTEMPTS = 3;

/** Canonical operations root: <workspace>/operations, honoring the
 *  user-configured workspace (which the desktop migrates to ~/Documents).
 *  All op call sites default here so they can't drift back to the old
 *  cwd-relative location after the workspace moves. Callers may still
 *  override via opts.workspaceDir. */
export function defaultOperationsDir(): string {
  return join(resolve(getRuntimeConfig().workspace), "operations");
}

function newOperationId(): string {
  return `op_${Date.now().toString(36)}_${randomBytes(4).toString("hex")}`;
}

function operationDir(workspaceDir: string, id: string): string {
  return join(workspaceDir, id);
}

function ensureWorkspace(workspaceDir: string): void {
  if (!existsSync(workspaceDir)) mkdirSync(workspaceDir, { recursive: true });
}

/** Create a new Operation — decompose goal, write plan to disk, return the spec. */
export async function createOperation(goal: string, opts: ConductorOptions = {}): Promise<Operation> {
  const workspaceDir = opts.workspaceDir || defaultOperationsDir();
  ensureWorkspace(workspaceDir);

  const decomp = await decomposeGoal(goal, { provider: opts.provider, model: opts.model, knownProtocols: opts.knownProtocols });

  const op: Operation = {
    id: newOperationId(),
    goal,
    summary: decomp.summary,
    phases: decomp.phases,
    status: "pending",
    createdAt: Date.now(),
    currentPhase: 0,
    sharedState: {},
    events: [{ ts: Date.now(), level: "info", message: `Operation created with ${decomp.phases.length} phases` }],
    preBlessedSecrets: opts.preBlessedSecrets && opts.preBlessedSecrets.length > 0 ? opts.preBlessedSecrets : undefined,
  };

  const dir = operationDir(workspaceDir, op.id);
  mkdirSync(dir, { recursive: true });
  writeOperation(workspaceDir, op);
  writePlanMarkdown(workspaceDir, op);
  return op;
}

/** Load an operation from disk. Returns null if not found or corrupted. */
export function loadOperation(workspaceDir: string, id: string): Operation | null {
  const file = join(operationDir(workspaceDir, id), "operation.json");
  if (!existsSync(file)) return null;
  try {
    return JSON.parse(readFileSync(file, "utf-8")) as Operation;
  } catch {
    return null;
  }
}

/** Persist operation state to disk. Atomic via temp-rename. */
export function writeOperation(workspaceDir: string, op: Operation): void {
  const dir = operationDir(workspaceDir, op.id);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const file = join(dir, "operation.json");
  const tmp = file + ".tmp";
  writeFileSync(tmp, JSON.stringify(op, null, 2), "utf-8");
  // rename is atomic on both platforms
  try { require("node:fs").renameSync(tmp, file); } catch { writeFileSync(file, JSON.stringify(op, null, 2), "utf-8"); }
}

/** List all operations in the workspace, newest first. */
export function listOperations(workspaceDir: string): Operation[] {
  if (!existsSync(workspaceDir)) return [];
  const ids = readdirSync(workspaceDir).filter(d => d.startsWith("op_"));
  const ops: Operation[] = [];
  for (const id of ids) {
    const op = loadOperation(workspaceDir, id);
    if (op) ops.push(op);
  }
  return ops.sort((a, b) => b.createdAt - a.createdAt);
}

/** Return the next pending phase, or null if operation is done. */
export function nextPhase(op: Operation): OperationPhase | null {
  for (let i = op.currentPhase; i < op.phases.length; i++) {
    if (op.phases[i].status === "pending" || op.phases[i].status === "running") {
      return op.phases[i];
    }
  }
  return null;
}

/**
 * Build the agent prompt for executing a specific phase.
 * This is the scoped instruction set that gets fed to the agent loop.
 */
export function buildPhasePrompt(op: Operation, phase: OperationPhase): string {
  const sharedCtx = Object.keys(op.sharedState).length > 0
    ? `\n\nShared context from earlier phases (DO NOT re-verify things already confirmed here — go straight to what is NOT yet done):\n${JSON.stringify(op.sharedState, null, 2)}\n`
    : "";
  const proto = phase.protocolName
    ? `\n\nThis phase matches protocol: ${phase.protocolName}. Use it if possible.\n`
    : "";
  const priorFailure = phase.attempts > 1 && phase.lastError
    ? `\n\n⚠️ This is retry attempt ${phase.attempts} of ${phase.attempts === 2 ? "2" : "3"}. The PREVIOUS attempt failed with: "${phase.lastError}". Do NOT repeat the same approach. Try a different path (deep link, direct URL, different tool) and finish the phase this time.\n`
    : "";
  return (
    `OPERATION: ${op.goal}\n` +
    `This phase: ${phase.name}\n` +
    `Phase goal: ${phase.goal}\n\n` +
    `Success criteria (all must be true before you mark complete):\n` +
    phase.successCriteria.map((c, i) => `  ${i + 1}. ${c}`).join("\n") +
    `\n\nSuggested tools for this phase: ${phase.suggestedTools.join(", ")}\n` +
    proto +
    sharedCtx +
    priorFailure +
    `\n\nWork quietly. Do NOT output a plan. Execute, then give a one-paragraph result with any key data (URLs, IDs, credentials placeholders) you discovered.`
  );
}

/** Mark a phase as started. Updates disk. */
export function markPhaseStarted(workspaceDir: string, op: Operation, phase: OperationPhase): void {
  phase.status = "running";
  phase.startedAt = Date.now();
  phase.attempts++;
  op.status = "running";
  if (!op.startedAt) op.startedAt = Date.now();
  addEvent(op, "progress", `Starting phase: ${phase.name} (attempt ${phase.attempts})`, phase.id);
  writeOperation(workspaceDir, op);
}

/** Mark a phase as completed with optional output. */
export function markPhaseCompleted(workspaceDir: string, op: Operation, phase: OperationPhase, output?: Record<string, unknown>): void {
  phase.status = "completed";
  phase.completedAt = Date.now();
  if (output) {
    phase.output = output;
    Object.assign(op.sharedState, output);
  }
  addEvent(op, "progress", `Completed: ${phase.name}`, phase.id);
  // Advance pointer
  const idx = op.phases.indexOf(phase);
  if (idx >= 0) op.currentPhase = idx + 1;
  // Check if all done
  if (op.phases.every(p => p.status === "completed" || p.status === "skipped")) {
    op.status = "completed";
    op.completedAt = Date.now();
    addEvent(op, "done", "Operation complete");
  }
  writeOperation(workspaceDir, op);
}

/** Mark a phase as failed. Retries or escalates depending on attempt count. */
export function markPhaseFailed(workspaceDir: string, op: Operation, phase: OperationPhase, error: string): { willRetry: boolean } {
  phase.lastError = error.slice(0, 500);
  if (phase.attempts >= MAX_PHASE_ATTEMPTS) {
    phase.status = "failed";
    op.status = "failed";
    addEvent(op, "error", `Phase failed after ${phase.attempts} attempts: ${phase.name} — ${error.slice(0, 200)}`, phase.id);
    writeOperation(workspaceDir, op);
    return { willRetry: false };
  }
  phase.status = "pending"; // reset to pending for retry
  addEvent(op, "error", `Phase failed (attempt ${phase.attempts}, will retry): ${phase.name} — ${error.slice(0, 200)}`, phase.id);
  writeOperation(workspaceDir, op);
  return { willRetry: true };
}

/** Pause the operation — typically because a phase needs user input. */
export function pauseOperation(workspaceDir: string, op: Operation, reason: string): void {
  op.status = "paused";
  addEvent(op, "blocked", reason);
  writeOperation(workspaceDir, op);
}

/** Cancel the operation — user aborted. */
export function cancelOperation(workspaceDir: string, op: Operation): void {
  op.status = "cancelled";
  addEvent(op, "info", "Cancelled by user");
  writeOperation(workspaceDir, op);
}

/** Append a user-facing event to the operation log. */
export function addEvent(op: Operation, level: OperationEvent["level"], message: string, phaseId?: string): void {
  op.events.push({ ts: Date.now(), level, phaseId, message });
  if (op.events.length > 200) op.events = op.events.slice(-200);
}

/** Append a free-form log line to the phase's log file. */
export function appendPhaseLog(workspaceDir: string, op: Operation, phase: OperationPhase, line: string): void {
  const idx = op.phases.indexOf(phase);
  const logFile = join(operationDir(workspaceDir, op.id), `phase-${idx + 1}.log`);
  const stamp = new Date().toISOString();
  try { appendFileSync(logFile, `[${stamp}] ${line}\n`, "utf-8"); } catch {}
}

/** Status summary — used by operation_status tool. */
export function statusSummary(op: Operation): string {
  const done = op.phases.filter(p => p.status === "completed").length;
  const total = op.phases.length;
  const current = op.phases[op.currentPhase]?.name || "—";
  const pct = total > 0 ? Math.round((done / total) * 100) : 0;
  const lines = [
    `Operation ${op.id}: ${op.status.toUpperCase()} — ${done}/${total} phases (${pct}%)`,
    `Goal: ${op.goal}`,
    `Current: ${current}`,
  ];
  if (op.events.length > 0) {
    lines.push("", "Recent events:");
    for (const e of op.events.slice(-5)) {
      lines.push(`  [${e.level}] ${e.message}`);
    }
  }
  return lines.join("\n");
}

function writePlanMarkdown(workspaceDir: string, op: Operation): void {
  const dir = operationDir(workspaceDir, op.id);
  const lines: string[] = [
    `# Operation: ${op.id}`,
    ``,
    `**Created:** ${new Date(op.createdAt).toISOString()}`,
    ``,
    `## Goal`,
    op.goal,
    ``,
    `## Summary`,
    op.summary,
    ``,
    `## Phases`,
    ``,
  ];
  for (let i = 0; i < op.phases.length; i++) {
    const p = op.phases[i];
    lines.push(`### ${i + 1}. ${p.name}`);
    lines.push(`- **Goal:** ${p.goal}`);
    if (p.protocolName) lines.push(`- **Protocol:** ${p.protocolName}`);
    lines.push(`- **Tools:** ${p.suggestedTools.join(", ")}`);
    if (p.successCriteria.length > 0) {
      lines.push(`- **Success criteria:**`);
      for (const c of p.successCriteria) lines.push(`  - ${c}`);
    }
    lines.push("");
  }
  writeFileSync(join(dir, "plan.md"), lines.join("\n"), "utf-8");
}
