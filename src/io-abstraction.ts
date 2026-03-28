// ── I/O Abstraction Layer ── Swap voice/display backends without code changes

import * as readline from "node:readline";

export interface IOProvider {
  input(prompt: string): Promise<string>;
  output(text: string): void;
  speak(text: string): Promise<void>;
  listen(): Promise<string>;
  display(content: string | Record<string, unknown>): void;
}

// ── Terminal I/O ──

export class TerminalIO implements IOProvider {
  private rl: readline.Interface | null = null;

  private getReadline(): readline.Interface {
    if (!this.rl) {
      this.rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout,
      });
    }
    return this.rl;
  }

  async input(prompt: string): Promise<string> {
    return new Promise((resolve) => {
      this.getReadline().question(prompt, (answer) => {
        resolve(answer);
      });
    });
  }

  output(text: string): void {
    process.stdout.write(text + "\n");
  }

  async speak(text: string): Promise<void> {
    // Terminal fallback: print spoken text with a prefix
    process.stdout.write(`[speak] ${text}\n`);
  }

  async listen(): Promise<string> {
    return this.input("[listening] > ");
  }

  display(content: string | Record<string, unknown>): void {
    if (typeof content === "string") {
      process.stdout.write(content + "\n");
    } else {
      process.stdout.write(JSON.stringify(content, null, 2) + "\n");
    }
  }

  close(): void {
    if (this.rl) {
      this.rl.close();
      this.rl = null;
    }
  }
}

// ── Web I/O ──

type WebSendFn = (type: string, data: unknown) => void;
type WebReceiveFn = () => Promise<string>;

export class WebIO implements IOProvider {
  private sendFn: WebSendFn;
  private receiveFn: WebReceiveFn;

  constructor(sendFn: WebSendFn, receiveFn: WebReceiveFn) {
    this.sendFn = sendFn;
    this.receiveFn = receiveFn;
  }

  async input(prompt: string): Promise<string> {
    this.sendFn("prompt", { text: prompt });
    return this.receiveFn();
  }

  output(text: string): void {
    this.sendFn("output", { text });
  }

  async speak(text: string): Promise<void> {
    this.sendFn("speak", { text });
  }

  async listen(): Promise<string> {
    this.sendFn("listen", {});
    return this.receiveFn();
  }

  display(content: string | Record<string, unknown>): void {
    this.sendFn("display", { content });
  }
}

// ── Headless I/O ──

export class HeadlessIO implements IOProvider {
  private inputQueue: string[] = [];
  private outputLog: string[] = [];
  private pendingResolvers: ((value: string) => void)[] = [];

  async input(_prompt: string): Promise<string> {
    if (this.inputQueue.length > 0) {
      return this.inputQueue.shift()!;
    }
    return new Promise((resolve) => {
      this.pendingResolvers.push(resolve);
    });
  }

  output(text: string): void {
    this.outputLog.push(text);
  }

  async speak(text: string): Promise<void> {
    this.outputLog.push(`[speak] ${text}`);
  }

  async listen(): Promise<string> {
    return this.input("");
  }

  display(content: string | Record<string, unknown>): void {
    const text = typeof content === "string" ? content : JSON.stringify(content);
    this.outputLog.push(text);
  }

  // Methods for programmatic control
  pushInput(text: string): void {
    if (this.pendingResolvers.length > 0) {
      const resolve = this.pendingResolvers.shift()!;
      resolve(text);
    } else {
      this.inputQueue.push(text);
    }
  }

  getOutputLog(): string[] {
    return [...this.outputLog];
  }

  clearOutputLog(): void {
    this.outputLog = [];
  }
}

// ── Factory ──

export function createIO(type: "terminal" | "web" | "headless", options?: {
  sendFn?: WebSendFn;
  receiveFn?: WebReceiveFn;
}): IOProvider {
  switch (type) {
    case "terminal":
      return new TerminalIO();
    case "web":
      if (!options?.sendFn || !options?.receiveFn) {
        throw new Error("WebIO requires sendFn and receiveFn in options");
      }
      return new WebIO(options.sendFn, options.receiveFn);
    case "headless":
      return new HeadlessIO();
    default:
      throw new Error(`Unknown IO type: ${type}`);
  }
}
