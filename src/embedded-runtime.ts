import { EventEmitter } from "node:events";

export interface EmbeddedRuntimeConfig {
  maxMemoryMB: number;
  enableVoice: boolean;
  enableVision: boolean;
  modelEndpoint: string;
  toolWhitelist: string[];
}

interface ToolHandler {
  name: string;
  execute(params: Record<string, unknown>): Promise<unknown>;
}

interface StreamChunk {
  text: string;
  done: boolean;
}

const ESSENTIAL_TOOLS = new Set([
  "file-read",
  "file-write",
  "shell",
  "search",
  "calculator",
  "calendar",
  "notes",
  "timer",
  "weather",
  "ocr",
]);

export class EmbeddedRuntime extends EventEmitter {
  private config: EmbeddedRuntimeConfig | null = null;
  private tools = new Map<string, ToolHandler>();
  private running = false;
  private contextWindow: Array<{ role: string; content: string }> = [];
  private maxContextEntries = 20;

  async init(config: EmbeddedRuntimeConfig): Promise<void> {
    this.config = config;
    this.running = true;
    this.maxContextEntries = Math.floor(config.maxMemoryMB / 8);
    if (this.maxContextEntries < 4) this.maxContextEntries = 4;
    if (this.maxContextEntries > 50) this.maxContextEntries = 50;
    this.contextWindow = [];
    this.tools.clear();
    this.emit("initialized", { maxMemoryMB: config.maxMemoryMB });
  }

  registerTool(handler: ToolHandler): void {
    if (!this.config) throw new Error("Runtime not initialized");
    const allowed =
      this.config.toolWhitelist.length === 0 ||
      this.config.toolWhitelist.includes(handler.name);
    if (!allowed) return;
    if (!ESSENTIAL_TOOLS.has(handler.name)) return;
    this.tools.set(handler.name, handler);
  }

  async processInput(text: string): Promise<string> {
    if (!this.config || !this.running) {
      throw new Error("Runtime not initialized or shut down");
    }
    this.pushContext("user", text);
    const response = await this.streamInference(text);
    this.pushContext("assistant", response);
    return response;
  }

  async processAudio(buffer: Buffer): Promise<string> {
    if (!this.config || !this.running) {
      throw new Error("Runtime not initialized or shut down");
    }
    if (!this.config.enableVoice) {
      throw new Error("Voice processing is disabled in config");
    }
    const transcript = await this.localSTT(buffer);
    return this.processInput(transcript);
  }

  async shutdown(): Promise<void> {
    this.running = false;
    this.contextWindow = [];
    this.tools.clear();
    this.config = null;
    this.emit("shutdown");
  }

  getMemoryUsageMB(): number {
    const usage = process.memoryUsage();
    return Math.round(usage.heapUsed / 1024 / 1024);
  }

  isRunning(): boolean {
    return this.running;
  }

  private pushContext(role: string, content: string): void {
    this.contextWindow.push({ role, content });
    while (this.contextWindow.length > this.maxContextEntries) {
      this.contextWindow.shift();
    }
  }

  private async streamInference(text: string): Promise<string> {
    if (!this.config) throw new Error("Runtime not initialized");
    const body = JSON.stringify({
      messages: [...this.contextWindow],
      stream: true,
      max_tokens: 512,
    });

    const url = this.config.modelEndpoint;
    let result = "";

    try {
      const response = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body,
      });

      if (!response.ok) {
        throw new Error(`Inference failed: ${response.status}`);
      }

      if (!response.body) {
        const json = (await response.json()) as { text?: string };
        return json.text ?? "";
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        const raw = decoder.decode(value, { stream: true });
        const lines = raw.split("\n").filter((l) => l.trim().length > 0);
        for (const line of lines) {
          try {
            const chunk = JSON.parse(line) as StreamChunk;
            result += chunk.text;
            this.emit("stream-chunk", chunk);
            if (chunk.done) break;
          } catch {
            result += line;
          }
        }
      }
    } catch (err) {
      this.emit("error", err);
      throw err;
    }

    return result;
  }

  private async localSTT(buffer: Buffer): Promise<string> {
    if (!this.config) throw new Error("Runtime not initialized");
    const endpoint = this.config.modelEndpoint.replace(
      /\/chat\/?$/,
      "/transcribe"
    );
    try {
      const response = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/octet-stream" },
        body: buffer.toString("base64"),
      });
      if (!response.ok) {
        throw new Error(`STT failed: ${response.status}`);
      }
      const json = (await response.json()) as { text: string };
      return json.text;
    } catch (err) {
      this.emit("error", err);
      throw err;
    }
  }
}
