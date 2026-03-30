/**
 * Execution Lanes — concurrent task scheduling with isolation.
 *
 * Each lane has its own queue and concurrency limit:
 * - Main: serialized (1 at a time) — user chat, auto-reply
 * - Cron: parallel (3 at a time) — scheduled jobs
 * - Agent: parallel (3 at a time) — spawned sub-agents
 * - Background: parallel (2 at a time) — memory consolidation, sync
 *
 * More robust than upstream's approach:
 * - Priority within lanes (urgent tasks jump the queue)
 * - Backpressure: rejects new tasks when queue is full (configurable)
 * - Per-task timeout with cleanup
 * - Metrics: wait time, execution time, queue depth per lane
 * - Graceful drain on shutdown
 */

import { EventBus } from "./event-bus.js";

// ── Types ──

export type LaneName = "main" | "cron" | "agent" | "background";

export interface LaneTask {
  id: string;
  lane: LaneName;
  priority: number;      // Higher = runs first (0 = normal, 10 = urgent)
  execute: () => Promise<unknown>;
  timeout?: number;       // ms, default 300_000 (5 min)
  label?: string;         // Human-readable description
  enqueuedAt: number;
}

interface LaneState {
  name: LaneName;
  maxConcurrent: number;
  maxQueueSize: number;
  queue: LaneTask[];
  active: Map<string, { task: LaneTask; startedAt: number; abortController: AbortController }>;
  draining: boolean;
  metrics: {
    totalEnqueued: number;
    totalCompleted: number;
    totalFailed: number;
    totalTimedOut: number;
    totalRejected: number;
    avgWaitMs: number;
    avgExecMs: number;
  };
}

// ── Lane Configuration ──

const DEFAULT_CONFIG: Record<LaneName, { maxConcurrent: number; maxQueueSize: number }> = {
  main: { maxConcurrent: 1, maxQueueSize: 50 },
  cron: { maxConcurrent: 3, maxQueueSize: 20 },
  agent: { maxConcurrent: 3, maxQueueSize: 10 },
  background: { maxConcurrent: 2, maxQueueSize: 30 },
};

const DEFAULT_TIMEOUT = 300_000; // 5 minutes

// ── State ──

const lanes = new Map<LaneName, LaneState>();
let globalDraining = false;

function getLane(name: LaneName): LaneState {
  if (!lanes.has(name)) {
    const cfg = DEFAULT_CONFIG[name] || { maxConcurrent: 1, maxQueueSize: 20 };
    lanes.set(name, {
      name,
      maxConcurrent: cfg.maxConcurrent,
      maxQueueSize: cfg.maxQueueSize,
      queue: [],
      active: new Map(),
      draining: false,
      metrics: { totalEnqueued: 0, totalCompleted: 0, totalFailed: 0, totalTimedOut: 0, totalRejected: 0, avgWaitMs: 0, avgExecMs: 0 },
    });
  }
  return lanes.get(name)!;
}

// Initialize all lanes
for (const name of Object.keys(DEFAULT_CONFIG) as LaneName[]) getLane(name);

// ── Core API ──

/**
 * Enqueue a task in a lane. Returns a promise that resolves when the task completes.
 * Rejects immediately if the lane is full or draining.
 */
export function enqueue<T = unknown>(
  lane: LaneName,
  execute: () => Promise<T>,
  opts?: { priority?: number; timeout?: number; label?: string },
): Promise<T> {
  const state = getLane(lane);

  if (globalDraining || state.draining) {
    state.metrics.totalRejected++;
    return Promise.reject(new Error(`Lane "${lane}" is draining — not accepting new tasks`));
  }

  if (state.queue.length >= state.maxQueueSize) {
    state.metrics.totalRejected++;
    return Promise.reject(new Error(`Lane "${lane}" queue is full (${state.maxQueueSize} tasks). Try again later.`));
  }

  return new Promise<T>((resolve, reject) => {
    const task: LaneTask = {
      id: `${lane}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      lane,
      priority: opts?.priority || 0,
      timeout: opts?.timeout || DEFAULT_TIMEOUT,
      label: opts?.label,
      enqueuedAt: Date.now(),
      execute: async () => {
        try {
          const result = await execute();
          resolve(result as T);
          return result;
        } catch (e) {
          reject(e);
          throw e;
        }
      },
    };

    // Insert by priority (higher priority = earlier in queue)
    const insertIdx = state.queue.findIndex(t => t.priority < task.priority);
    if (insertIdx >= 0) {
      state.queue.splice(insertIdx, 0, task);
    } else {
      state.queue.push(task);
    }

    state.metrics.totalEnqueued++;
    pump(lane);
  });
}

/**
 * Pump a lane: start tasks up to the concurrency limit.
 */
function pump(laneName: LaneName): void {
  const state = getLane(laneName);

  while (state.active.size < state.maxConcurrent && state.queue.length > 0) {
    const task = state.queue.shift()!;
    const waitMs = Date.now() - task.enqueuedAt;

    // Warn on long waits
    if (waitMs > 5000) {
      console.warn(`[lanes] Task waited ${(waitMs / 1000).toFixed(1)}s in ${laneName} queue: ${task.label || task.id}`);
    }

    // Update avg wait time
    const m = state.metrics;
    m.avgWaitMs = m.totalCompleted > 0
      ? (m.avgWaitMs * m.totalCompleted + waitMs) / (m.totalCompleted + 1)
      : waitMs;

    const abortController = new AbortController();
    const startedAt = Date.now();
    state.active.set(task.id, { task, startedAt, abortController });

    // Timeout handler
    const timeoutId = setTimeout(() => {
      abortController.abort();
      state.active.delete(task.id);
      state.metrics.totalTimedOut++;
      console.warn(`[lanes] Task timed out in ${laneName}: ${task.label || task.id} (${(task.timeout! / 1000).toFixed(0)}s)`);
      pump(laneName);
    }, task.timeout || DEFAULT_TIMEOUT);

    // Execute
    task.execute()
      .then(() => {
        state.metrics.totalCompleted++;
        const execMs = Date.now() - startedAt;
        m.avgExecMs = m.totalCompleted > 0
          ? (m.avgExecMs * (m.totalCompleted - 1) + execMs) / m.totalCompleted
          : execMs;
      })
      .catch(() => {
        state.metrics.totalFailed++;
      })
      .finally(() => {
        clearTimeout(timeoutId);
        state.active.delete(task.id);
        EventBus.emit("lane:task-complete", { lane: laneName, taskId: task.id });
        pump(laneName);
      });
  }
}

// ── Configuration ──

/**
 * Set concurrency for a lane at runtime.
 */
export function setLaneConcurrency(lane: LaneName, maxConcurrent: number): void {
  const state = getLane(lane);
  state.maxConcurrent = Math.max(1, maxConcurrent);
  console.log(`[lanes] ${lane} concurrency set to ${state.maxConcurrent}`);
  pump(lane);
}

/**
 * Set max queue size for a lane.
 */
export function setLaneQueueSize(lane: LaneName, maxQueueSize: number): void {
  const state = getLane(lane);
  state.maxQueueSize = Math.max(1, maxQueueSize);
}

// ── Monitoring ──

/**
 * Get current status of all lanes.
 */
export function getLaneStatus(): Record<LaneName, {
  active: number;
  queued: number;
  maxConcurrent: number;
  draining: boolean;
  metrics: LaneState["metrics"];
}> {
  const result: Record<string, unknown> = {};
  for (const [name, state] of lanes) {
    result[name] = {
      active: state.active.size,
      queued: state.queue.length,
      maxConcurrent: state.maxConcurrent,
      draining: state.draining,
      metrics: { ...state.metrics },
    };
  }
  return result as any;
}

/**
 * Get active tasks in a lane.
 */
export function getActiveTasks(lane: LaneName): Array<{ id: string; label?: string; runningMs: number }> {
  const state = getLane(lane);
  const now = Date.now();
  return Array.from(state.active.values()).map(a => ({
    id: a.task.id,
    label: a.task.label,
    runningMs: now - a.startedAt,
  }));
}

// ── Shutdown ──

/**
 * Mark all lanes as draining — no new tasks accepted.
 * In-flight tasks will complete.
 */
export function drainAll(): void {
  globalDraining = true;
  for (const state of lanes.values()) {
    state.draining = true;
  }
  console.log("[lanes] All lanes draining — no new tasks accepted");
}

/**
 * Wait for all active tasks to complete (with timeout).
 */
export function waitForDrain(timeoutMs: number = 30000): Promise<void> {
  return new Promise((resolve) => {
    const deadline = Date.now() + timeoutMs;
    const check = () => {
      let totalActive = 0;
      for (const state of lanes.values()) totalActive += state.active.size;
      if (totalActive === 0 || Date.now() > deadline) {
        resolve();
        return;
      }
      setTimeout(check, 500);
    };
    check();
  });
}

/**
 * Cancel all tasks in a lane.
 */
export function cancelLane(lane: LaneName): number {
  const state = getLane(lane);
  const cancelled = state.queue.length + state.active.size;
  state.queue = [];
  for (const [id, entry] of state.active) {
    entry.abortController.abort();
    state.active.delete(id);
  }
  return cancelled;
}
