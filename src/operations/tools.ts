/**
 * Operation tools — what the agent (and user via chat) uses to create,
 * inspect, and advance an Operation.
 *
 * Shipping 5 tools in this first pass:
 *   operation_start   — decompose a goal, create mission dir, return plan preview
 *   operation_list    — list active operations
 *   operation_status  — return current phase + progress for an operation
 *   operation_next    — returns the next phase's scoped prompt (for agent to execute)
 *   operation_advance — mark current phase complete (with output) / failed / paused
 *
 * The execution loop itself (running phases autonomously) is a Sprint 3
 * concern — for now the agent manually calls operation_next to get a phase
 * prompt, executes it via its normal tool loop, and calls operation_advance
 * when done.
 */
import { join } from "node:path";
import type { ToolDefinition } from "../types.js";
import {
  createOperation, loadOperation, writeOperation, listOperations,
  nextPhase, buildPhasePrompt, markPhaseStarted, markPhaseCompleted,
  markPhaseFailed, pauseOperation, cancelOperation, appendPhaseLog,
  statusSummary,
} from "./conductor.js";

function workspaceDir(): string {
  return join(process.cwd(), "workspace", "operations");
}

export function createOperationTools(): ToolDefinition[] {
  return [
    {
      name: "operation_start",
      description:
        "Start a new long-horizon Operation. Use when the user asks for a multi-step goal that can't be finished in one chat turn " +
        "(e.g., 'build me a WooCommerce store', 'set up pmajlabs.com email + DNS', 'deploy this app end-to-end'). " +
        "The goal is decomposed into phases by an LLM planner; you then call operation_next to get each phase's scoped prompt " +
        "and execute it before calling operation_advance. For one-shot actions (single tool call, <5 min), do NOT use operations.",
      parameters: {
        type: "object",
        properties: {
          goal: { type: "string", description: "The user's goal verbatim. Be specific — 'build a WooCommerce store for pmajlabs.com with Stripe checkout' beats 'build an ecommerce site'." },
          provider: { type: "string", enum: ["ollama", "anthropic", "openai", "auto"], description: "LLM for decomposition (default auto)" },
          model: { type: "string", description: "Override model for the decomposer" },
        },
        required: ["goal"],
      },
      async execute(args) {
        const goal = String(args.goal || "");
        if (!goal.trim()) return { content: "goal is required", isError: true };
        const op = await createOperation(goal, {
          workspaceDir: workspaceDir(),
          provider: args.provider as "ollama" | "anthropic" | "openai" | "auto" | undefined,
          model: typeof args.model === "string" ? args.model : undefined,
        });
        const lines = [
          `Operation ${op.id} created — ${op.phases.length} phases`,
          ``,
          `Goal: ${op.goal}`,
          `Summary: ${op.summary}`,
          ``,
          `Phases:`,
          ...op.phases.map((p, i) => `  ${i + 1}. ${p.name} — ${p.goal.slice(0, 100)}`),
          ``,
          `Plan saved to: workspace/operations/${op.id}/plan.md`,
          `Next: call operation_next with operation_id="${op.id}" to get the first phase's scoped prompt.`,
        ];
        return { content: lines.join("\n") };
      },
    },

    {
      name: "operation_list",
      description: "List all Operations (active, completed, failed, cancelled). Returns id, goal, status, and phase progress.",
      parameters: { type: "object", properties: {} },
      async execute() {
        const ops = listOperations(workspaceDir());
        if (ops.length === 0) return { content: "No operations yet. Start one with operation_start." };
        const lines = ops.map(op => {
          const done = op.phases.filter(p => p.status === "completed").length;
          return `[${op.status}] ${op.id} — ${op.goal.slice(0, 80)} (${done}/${op.phases.length} phases)`;
        });
        return { content: lines.join("\n") };
      },
    },

    {
      name: "operation_status",
      description: "Get current status of an Operation: phase progress, current phase, recent events.",
      parameters: {
        type: "object",
        properties: {
          operation_id: { type: "string", description: "The operation ID (from operation_start or operation_list)" },
        },
        required: ["operation_id"],
      },
      async execute(args) {
        const op = loadOperation(workspaceDir(), String(args.operation_id || ""));
        if (!op) return { content: "Operation not found", isError: true };
        return { content: statusSummary(op) };
      },
    },

    {
      name: "operation_next",
      description:
        "Get the next phase's scoped execution prompt for an Operation. Call this to learn what phase to execute next. " +
        "Returns a phase id + a focused prompt describing the phase's goal, success criteria, and suggested tools. " +
        "After you execute the phase (using your normal tools), call operation_advance with the outcome.",
      parameters: {
        type: "object",
        properties: {
          operation_id: { type: "string", description: "The operation ID" },
        },
        required: ["operation_id"],
      },
      async execute(args) {
        const op = loadOperation(workspaceDir(), String(args.operation_id || ""));
        if (!op) return { content: "Operation not found", isError: true };
        if (op.status === "completed") return { content: "Operation is already complete." };
        if (op.status === "cancelled") return { content: "Operation was cancelled." };
        if (op.status === "failed") return { content: "Operation failed. Use operation_status for details." };
        const phase = nextPhase(op);
        if (!phase) return { content: "No pending phases. Operation may be complete." };
        markPhaseStarted(workspaceDir(), op, phase);
        const prompt = buildPhasePrompt(op, phase);
        return {
          content:
            `PHASE ID: ${phase.id}\n` +
            `OPERATION ID: ${op.id}\n` +
            `PHASE ${op.currentPhase + 1}/${op.phases.length}: ${phase.name}\n\n` +
            `${prompt}\n\n` +
            `When done, call operation_advance with operation_id, phase_id, outcome="completed" and output={key:value} of what you produced.`,
        };
      },
    },

    {
      name: "operation_advance",
      description:
        "Record a phase's outcome and advance the Operation. Call this AFTER executing the phase returned by operation_next. " +
        "For completed: pass any durable outputs (URLs, IDs, config values) in `output` so later phases can use them. " +
        "For failed: include a terse error — phase will retry up to 3 times; after that the operation is marked failed. " +
        "For paused: use when the phase needs the user (credentials, decision) — operation stops until user responds.",
      parameters: {
        type: "object",
        properties: {
          operation_id: { type: "string", description: "The operation ID" },
          phase_id: { type: "string", description: "The phase ID from operation_next" },
          outcome: { type: "string", enum: ["completed", "failed", "paused", "cancelled"], description: "Phase result" },
          output: { type: "object", description: "For completed: key/value data this phase produced (URLs, IDs, etc.)" },
          error: { type: "string", description: "For failed: short error description" },
          reason: { type: "string", description: "For paused: why user input is needed" },
          log: { type: "string", description: "Optional free-form log line for phase-N.log" },
        },
        required: ["operation_id", "phase_id", "outcome"],
      },
      async execute(args) {
        const op = loadOperation(workspaceDir(), String(args.operation_id || ""));
        if (!op) return { content: "Operation not found", isError: true };
        const phase = op.phases.find(p => p.id === String(args.phase_id || ""));
        if (!phase) return { content: "Phase not found", isError: true };
        const outcome = String(args.outcome || "completed");
        if (typeof args.log === "string" && args.log) appendPhaseLog(workspaceDir(), op, phase, String(args.log));

        if (outcome === "completed") {
          const output = args.output && typeof args.output === "object" ? args.output as Record<string, unknown> : undefined;
          markPhaseCompleted(workspaceDir(), op, phase, output);
          const reloaded = loadOperation(workspaceDir(), op.id)!;
          if (reloaded.status === "completed") {
            return { content: `Operation ${op.id} COMPLETE.\n\n${statusSummary(reloaded)}` };
          }
          return { content: `Phase ${phase.name} complete. Call operation_next to get the next phase.` };
        }
        if (outcome === "failed") {
          const err = String(args.error || "Phase failed");
          const r = markPhaseFailed(workspaceDir(), op, phase, err);
          if (r.willRetry) {
            return { content: `Phase ${phase.name} failed (${err}). Will retry — call operation_next to try again.` };
          }
          return { content: `Phase ${phase.name} FAILED permanently after ${phase.attempts} attempts. Operation marked failed.` };
        }
        if (outcome === "paused") {
          pauseOperation(workspaceDir(), op, String(args.reason || `Phase ${phase.name} paused`));
          return { content: `Operation paused. Reason: ${args.reason || "(none)"}. Resume with operation_next after resolving.` };
        }
        if (outcome === "cancelled") {
          cancelOperation(workspaceDir(), op);
          return { content: `Operation ${op.id} cancelled.` };
        }
        return { content: `Unknown outcome: ${outcome}`, isError: true };
      },
    },
  ];
}
