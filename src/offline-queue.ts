import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { getLaxDir } from "./lax-data-dir.js";

interface QueuedRequest {
  id: string;
  method: string;
  url: string;
  body: unknown;
  headers: Record<string, string>;
  enqueuedAt: number;
}

interface QueueData {
  requests: QueuedRequest[];
}

export class OfflineQueue {
  private queuePath: string;
  private healthUrl: string;
  private processing = false;

  constructor(healthUrl: string) {
    const dir = getLaxDir();
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    this.queuePath = join(dir, "offline-queue.json");
    this.healthUrl = healthUrl;
  }

  private load(): QueueData {
    if (!existsSync(this.queuePath)) return { requests: [] };
    try {
      return JSON.parse(readFileSync(this.queuePath, "utf-8"));
    } catch {
      return { requests: [] };
    }
  }

  private save(data: QueueData): void {
    writeFileSync(this.queuePath, JSON.stringify(data, null, 2), "utf-8");
  }

  enqueue(request: {
    method: string;
    url: string;
    body?: unknown;
    headers?: Record<string, string>;
  }): string {
    const data = this.load();
    const id = `${Date.now().toString(36)}-${randomBytes(4).toString("hex")}`;
    data.requests.push({
      id,
      method: request.method,
      url: request.url,
      body: request.body ?? null,
      headers: request.headers ?? {},
      enqueuedAt: Date.now(),
    });
    this.save(data);
    return id;
  }

  async isOnline(): Promise<boolean> {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 5000);
      const resp = await fetch(this.healthUrl, { signal: controller.signal, method: "HEAD" });
      clearTimeout(timer);
      return resp.ok || resp.status < 500;
    } catch {
      return false;
    }
  }

  async processQueue(): Promise<{
    processed: number;
    failed: number;
    remaining: number;
  }> {
    if (this.processing) {
      return { processed: 0, failed: 0, remaining: this.getQueueSize() };
    }

    const online = await this.isOnline();
    if (!online) {
      return { processed: 0, failed: 0, remaining: this.getQueueSize() };
    }

    this.processing = true;
    let processed = 0;
    let failed = 0;

    try {
      const data = this.load();
      const remaining: QueuedRequest[] = [];

      // Process FIFO
      for (const request of data.requests) {
        try {
          const fetchOpts: RequestInit = {
            method: request.method,
            headers: request.headers,
          };
          if (request.body && request.method !== "GET" && request.method !== "HEAD") {
            fetchOpts.body = JSON.stringify(request.body);
          }
          const resp = await fetch(request.url, fetchOpts);
          if (resp.ok) {
            processed++;
          } else if (resp.status >= 500) {
            // Server error, keep in queue for retry
            remaining.push(request);
            failed++;
          } else {
            // Client error, discard
            processed++;
          }
        } catch {
          remaining.push(request);
          failed++;
        }
      }

      this.save({ requests: remaining });
      return { processed, failed, remaining: remaining.length };
    } finally {
      this.processing = false;
    }
  }

  getQueueSize(): number {
    return this.load().requests.length;
  }

  clearQueue(): void {
    this.save({ requests: [] });
  }

  getQueue(): QueuedRequest[] {
    return this.load().requests;
  }
}
