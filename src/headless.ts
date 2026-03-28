// ── Headless Mode ── Run agent without UI, API-only

export interface HeadlessConfig {
  provider: "openai" | "anthropic" | "local";
  model: string;
  systemPrompt: string;
  tools: HeadlessTool[];
  onStream?: (delta: string) => void;
  onToolCall?: (name: string, args: Record<string, unknown>) => void;
  onError?: (error: Error) => void;
}

export interface HeadlessTool {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  execute: (args: Record<string, unknown>) => Promise<{ content: string; isError?: boolean }>;
}

export interface HistoryEntry {
  role: "user" | "assistant" | "tool";
  content: string;
  timestamp: number;
  toolName?: string;
}

export class HeadlessAgent {
  private config: HeadlessConfig;
  private history: HistoryEntry[] = [];
  private toolMap = new Map<string, HeadlessTool>();
  private pendingResponse: string | null = null;
  private running = false;

  constructor(config: HeadlessConfig) {
    this.config = config;
    for (const tool of config.tools) {
      this.toolMap.set(tool.name, tool);
    }
  }

  async sendMessage(text: string): Promise<string> {
    this.history.push({ role: "user", content: text, timestamp: Date.now() });

    try {
      this.running = true;
      const response = await this.processMessage(text);
      this.history.push({ role: "assistant", content: response, timestamp: Date.now() });
      this.pendingResponse = response;
      return response;
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      this.config.onError?.(error);
      throw error;
    } finally {
      this.running = false;
    }
  }

  getResponse(): string | null {
    return this.pendingResponse;
  }

  async runTool(name: string, args: Record<string, unknown>): Promise<string> {
    const tool = this.toolMap.get(name);
    if (!tool) {
      throw new Error(`Tool "${name}" not found. Available: ${[...this.toolMap.keys()].join(", ")}`);
    }

    this.config.onToolCall?.(name, args);
    const result = await tool.execute(args);

    this.history.push({
      role: "tool",
      content: result.content,
      timestamp: Date.now(),
      toolName: name,
    });

    return result.content;
  }

  getHistory(): HistoryEntry[] {
    return [...this.history];
  }

  clearHistory(): void {
    this.history = [];
    this.pendingResponse = null;
  }

  isRunning(): boolean {
    return this.running;
  }

  getConfig(): Readonly<HeadlessConfig> {
    return this.config;
  }

  addTool(tool: HeadlessTool): void {
    this.toolMap.set(tool.name, tool);
    this.config.tools.push(tool);
  }

  removeTool(name: string): boolean {
    this.toolMap.delete(name);
    const idx = this.config.tools.findIndex((t) => t.name === name);
    if (idx >= 0) {
      this.config.tools.splice(idx, 1);
      return true;
    }
    return false;
  }

  private async processMessage(text: string): Promise<string> {
    // Build the message context for the provider
    const messages = [
      { role: "system" as const, content: this.config.systemPrompt },
      ...this.history.map((h) => ({ role: h.role, content: h.content })),
    ];

    // Provider-agnostic request construction
    // In a real integration, this dispatches to the configured provider.
    // For standalone headless use, it returns the context for external callers.
    const response = await this.callProvider(messages);

    // Stream deltas if callback is set
    if (this.config.onStream && response) {
      // Simulate streaming by sending the full response as a single delta
      this.config.onStream(response);
    }

    return response;
  }

  private async callProvider(
    messages: { role: string; content: string }[]
  ): Promise<string> {
    const { provider, model } = this.config;

    // Build provider-specific request payloads
    // External callers can override this by subclassing or by hooking into
    // the sendMessage flow with a custom provider adapter.
    const payload = {
      provider,
      model,
      messages,
      tools: this.config.tools.map((t) => ({
        name: t.name,
        description: t.description,
        parameters: t.parameters,
      })),
    };

    // When running truly headless (no server), this is a pass-through.
    // Integration with real providers happens via the server's agent pipeline.
    // This class is designed to be subclassed or composed with a provider client.
    return JSON.stringify({
      type: "headless_request",
      payload,
      hint: "Override callProvider() or use HeadlessAgent with a server connection for live inference.",
    });
  }
}
