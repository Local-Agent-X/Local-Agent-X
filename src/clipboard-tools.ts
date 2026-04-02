import { execFile } from "node:child_process";
import type { ToolDefinition, ToolResult } from "./types.js";

function run(args: string[], stdin?: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = execFile(
      "powershell",
      ["-NoProfile", "-Command", ...args],
      { timeout: 5000 },
      (err, stdout, stderr) => {
        if (err) return reject(new Error(stderr || err.message));
        resolve(stdout.trimEnd());
      },
    );
    if (stdin !== undefined) {
      child.stdin?.write(stdin);
      child.stdin?.end();
    }
  });
}

function ok(content: string, meta?: Record<string, unknown>): ToolResult {
  return { content, metadata: meta };
}
function fail(msg: string): ToolResult {
  return { content: msg, isError: true };
}

const clipboardRead: ToolDefinition = {
  name: "clipboard_read",
  description: "Read the current text content from the system clipboard.",
  parameters: { type: "object", properties: {}, required: [] },
  async execute(_args, signal) {
    try {
      signal?.throwIfAborted();
      const text = await run(["Get-Clipboard"]);
      if (!text) return ok("(clipboard is empty)");
      return ok(text, { length: text.length });
    } catch (e: unknown) {
      return fail(`Clipboard read failed: ${(e as Error).message}`);
    }
  },
};

const clipboardWrite: ToolDefinition = {
  name: "clipboard_write",
  description:
    'Write text to the system clipboard. Example: text="Hello, copied to clipboard!"',
  parameters: {
    type: "object",
    properties: { text: { type: "string", description: "Text to copy" } },
    required: ["text"],
  },
  async execute(args, signal) {
    try {
      signal?.throwIfAborted();
      const text = String(args.text ?? "");
      if (!text) return fail("No text provided.");
      await run(["$input | Set-Clipboard"], text);
      return ok(`Copied ${text.length} chars to clipboard.`);
    } catch (e: unknown) {
      return fail(`Clipboard write failed: ${(e as Error).message}`);
    }
  },
};

export const clipboardTools: ToolDefinition[] = [clipboardRead, clipboardWrite];
export function createClipboardTools(): ToolDefinition[] {
  return clipboardTools;
}
