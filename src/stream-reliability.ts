import { EventEmitter } from "node:events";

interface ReliableStreamOptions {
  url: string;
  heartbeatTimeoutMs?: number;
  maxReconnectAttempts?: number;
  baseReconnectDelayMs?: number;
  headers?: Record<string, string>;
}

export class ReliableStream extends EventEmitter {
  private url: string;
  private heartbeatTimeoutMs: number;
  private maxReconnectAttempts: number;
  private baseReconnectDelayMs: number;
  private headers: Record<string, string>;

  private controller: AbortController | null = null;
  private heartbeatTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectAttempts = 0;
  private buffer: string[] = [];
  private connected = false;
  private closed = false;
  private lastEventId: string | null = null;

  onData: ((data: string) => void) | null = null;
  onError: ((error: Error) => void) | null = null;
  onReconnect: ((attempt: number) => void) | null = null;

  constructor(options: ReliableStreamOptions) {
    super();
    this.url = options.url;
    this.heartbeatTimeoutMs = options.heartbeatTimeoutMs ?? 30_000;
    this.maxReconnectAttempts = options.maxReconnectAttempts ?? 10;
    this.baseReconnectDelayMs = options.baseReconnectDelayMs ?? 1000;
    this.headers = options.headers ?? {};
  }

  async connect(): Promise<void> {
    if (this.closed) return;
    this.controller = new AbortController();

    const headers: Record<string, string> = {
      Accept: "text/event-stream",
      "Cache-Control": "no-cache",
      ...this.headers,
    };
    if (this.lastEventId) {
      headers["Last-Event-ID"] = this.lastEventId;
    }

    try {
      const response = await fetch(this.url, {
        signal: this.controller.signal,
        headers,
      });

      if (!response.ok || !response.body) {
        throw new Error(`Stream connection failed: ${response.status}`);
      }

      this.connected = true;
      this.reconnectAttempts = 0;
      this.replayBuffer();
      this.resetHeartbeat();

      const reader = response.body.getReader();
      const decoder = new TextDecoder();

      while (!this.closed) {
        const { done, value } = await reader.read();
        if (done) break;

        const text = decoder.decode(value, { stream: true });
        this.resetHeartbeat();
        this.handleChunk(text);
      }

      // Stream ended normally
      if (!this.closed) {
        this.connected = false;
        this.scheduleReconnect();
      }
    } catch (err) {
      if (this.closed) return;
      this.connected = false;
      const error = err instanceof Error ? err : new Error(String(err));
      if (this.onError) this.onError(error);
      this.emit("error", error);
      this.scheduleReconnect();
    }
  }

  private handleChunk(text: string): void {
    const lines = text.split("\n");
    for (const line of lines) {
      if (line.startsWith("id:")) {
        this.lastEventId = line.slice(3).trim();
      } else if (line.startsWith("data:")) {
        const data = line.slice(5).trim();
        if (this.onData) this.onData(data);
        this.emit("data", data);
      }
    }
  }

  private resetHeartbeat(): void {
    if (this.heartbeatTimer) clearTimeout(this.heartbeatTimer);
    this.heartbeatTimer = setTimeout(() => {
      // No data received within heartbeat window, force reconnect
      this.disconnect();
      this.scheduleReconnect();
    }, this.heartbeatTimeoutMs);
  }

  private scheduleReconnect(): void {
    if (this.closed) return;
    if (this.reconnectAttempts >= this.maxReconnectAttempts) {
      const err = new Error(`Max reconnect attempts (${this.maxReconnectAttempts}) exceeded`);
      if (this.onError) this.onError(err);
      this.emit("error", err);
      return;
    }

    this.reconnectAttempts++;
    const delay = this.baseReconnectDelayMs * Math.pow(2, this.reconnectAttempts - 1);
    const jitter = Math.random() * this.baseReconnectDelayMs * 0.5;

    if (this.onReconnect) this.onReconnect(this.reconnectAttempts);
    this.emit("reconnect", this.reconnectAttempts);

    setTimeout(() => this.connect(), delay + jitter);
  }

  private replayBuffer(): void {
    const pending = this.buffer.splice(0);
    for (const msg of pending) {
      if (this.onData) this.onData(msg);
      this.emit("data", msg);
    }
  }

  bufferMessage(data: string): void {
    this.buffer.push(data);
  }

  disconnect(): void {
    if (this.heartbeatTimer) {
      clearTimeout(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    if (this.controller) {
      this.controller.abort();
      this.controller = null;
    }
    this.connected = false;
  }

  close(): void {
    this.closed = true;
    this.disconnect();
    this.buffer.length = 0;
  }

  isConnected(): boolean {
    return this.connected;
  }

  getReconnectAttempts(): number {
    return this.reconnectAttempts;
  }
}
