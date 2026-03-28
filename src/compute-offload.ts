import { EventEmitter } from "node:events";

export type TaskType =
  | "llm-inference"
  | "tts"
  | "stt"
  | "vision"
  | "ocr"
  | "embedding";

export interface ComputeTask {
  type: TaskType;
  payload: unknown;
  maxLatencyMs?: number;
}

export interface ComputeResult {
  data: unknown;
  route: "local" | "cloud";
  latencyMs: number;
  cost: number;
}

interface LocalCapability {
  type: TaskType;
  maxPayloadBytes: number;
  estimatedLatencyMs: number;
  handler: (payload: unknown) => Promise<unknown>;
}

interface CloudCapability {
  type: TaskType;
  endpoint: string;
  apiKey?: string;
  estimatedLatencyMs: number;
  costPerCall: number;
}

interface RouteStats {
  totalCalls: number;
  totalLatencyMs: number;
  totalCost: number;
  failures: number;
}

export class ComputeRouter extends EventEmitter {
  private localCaps = new Map<TaskType, LocalCapability>();
  private cloudCaps = new Map<TaskType, CloudCapability>();
  private stats = new Map<string, RouteStats>();
  private localBudgetMs: number;
  private cloudAvailable = true;

  constructor(localBudgetMs = 2000) {
    super();
    this.localBudgetMs = localBudgetMs;
  }

  registerLocal(capability: LocalCapability): void {
    this.localCaps.set(capability.type, capability);
    this.ensureStats(`local:${capability.type}`);
  }

  registerCloud(
    type: TaskType,
    endpoint: string,
    options?: { apiKey?: string; estimatedLatencyMs?: number; costPerCall?: number }
  ): void {
    this.cloudCaps.set(type, {
      type,
      endpoint,
      apiKey: options?.apiKey,
      estimatedLatencyMs: options?.estimatedLatencyMs ?? 500,
      costPerCall: options?.costPerCall ?? 0.01,
    });
    this.ensureStats(`cloud:${type}`);
  }

  async route(task: ComputeTask): Promise<ComputeResult> {
    const local = this.localCaps.get(task.type);
    const cloud = this.cloudCaps.get(task.type);

    const shouldRunLocal = local && this.fitsLocalBudget(local, task);

    if (shouldRunLocal) {
      try {
        return await this.runLocal(local!, task);
      } catch (err) {
        this.recordFailure(`local:${task.type}`);
        this.emit("local-failure", { type: task.type, error: err });
        if (cloud && this.cloudAvailable) {
          return this.runCloud(cloud, task);
        }
        throw err;
      }
    }

    if (cloud && this.cloudAvailable) {
      try {
        return await this.runCloud(cloud, task);
      } catch (err) {
        this.recordFailure(`cloud:${task.type}`);
        this.emit("cloud-failure", { type: task.type, error: err });
        this.cloudAvailable = false;
        this.scheduleCloudRetry();

        if (local) {
          this.emit("degraded", { type: task.type, reason: "cloud-unreachable" });
          return this.runLocal(local, task);
        }
        throw err;
      }
    }

    if (local) {
      this.emit("degraded", { type: task.type, reason: "no-cloud-registered" });
      return this.runLocal(local, task);
    }

    throw new Error(`No capability registered for task type: ${task.type}`);
  }

  getStats(): Map<string, RouteStats> {
    return new Map(this.stats);
  }

  getAverageLatency(key: string): number {
    const s = this.stats.get(key);
    if (!s || s.totalCalls === 0) return 0;
    return Math.round(s.totalLatencyMs / s.totalCalls);
  }

  setCloudAvailable(available: boolean): void {
    this.cloudAvailable = available;
  }

  private fitsLocalBudget(cap: LocalCapability, task: ComputeTask): boolean {
    const maxLatency = task.maxLatencyMs ?? this.localBudgetMs;
    return cap.estimatedLatencyMs <= maxLatency;
  }

  private async runLocal(
    cap: LocalCapability,
    task: ComputeTask
  ): Promise<ComputeResult> {
    const start = performance.now();
    const data = await cap.handler(task.payload);
    const latencyMs = Math.round(performance.now() - start);
    this.recordCall(`local:${task.type}`, latencyMs, 0);
    return { data, route: "local", latencyMs, cost: 0 };
  }

  private async runCloud(
    cap: CloudCapability,
    task: ComputeTask
  ): Promise<ComputeResult> {
    const start = performance.now();
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };
    if (cap.apiKey) headers["Authorization"] = `Bearer ${cap.apiKey}`;

    const response = await fetch(cap.endpoint, {
      method: "POST",
      headers,
      body: JSON.stringify({ type: task.type, payload: task.payload }),
    });

    if (!response.ok) {
      throw new Error(`Cloud call failed: ${response.status}`);
    }

    const data = await response.json();
    const latencyMs = Math.round(performance.now() - start);
    this.recordCall(`cloud:${task.type}`, latencyMs, cap.costPerCall);
    return { data, route: "cloud", latencyMs, cost: cap.costPerCall };
  }

  private ensureStats(key: string): void {
    if (!this.stats.has(key)) {
      this.stats.set(key, {
        totalCalls: 0,
        totalLatencyMs: 0,
        totalCost: 0,
        failures: 0,
      });
    }
  }

  private recordCall(key: string, latencyMs: number, cost: number): void {
    this.ensureStats(key);
    const s = this.stats.get(key)!;
    s.totalCalls++;
    s.totalLatencyMs += latencyMs;
    s.totalCost += cost;
  }

  private recordFailure(key: string): void {
    this.ensureStats(key);
    this.stats.get(key)!.failures++;
  }

  private scheduleCloudRetry(): void {
    setTimeout(() => {
      this.cloudAvailable = true;
      this.emit("cloud-retry");
    }, 30000);
  }
}
