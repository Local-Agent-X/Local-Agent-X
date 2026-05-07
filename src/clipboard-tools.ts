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

/**
 * Server-side: copy a vault-stored secret to the clipboard WITHOUT the model
 * ever seeing the value. Counterpart to `browser_fill_from_secret` for the
 * "user wants the secret on their clipboard for use elsewhere" flow.
 *
 * Security model:
 *   - Tool reads the value from the secrets vault server-side (DPAPI-decrypted)
 *   - Pipes the value via stdin to PowerShell `Set-Clipboard`
 *   - Returns ONLY a length confirmation — the value never appears in tool
 *     output, so it never enters the conversation history sent to the model
 *     provider (Anthropic / OpenAI / etc.)
 *   - Registers the value with the redactor so any later snapshot/extract
 *     accidentally containing it gets scrubbed before reaching the model
 */
const clipboardWriteFromSecret: ToolDefinition = {
  name: "clipboard_write_from_secret",
  description:
    "Copy a vault-stored secret value to the system clipboard WITHOUT the model ever seeing it. " +
    "Use this when the user wants a secret on their clipboard (to paste into a 3rd-party UI) but the " +
    "value should never enter your context. Pass the secret name (the same name used by " +
    "browser_capture_to_secret / browser_fill_from_secret). Tool returns only a length confirmation.",
  parameters: {
    type: "object",
    properties: {
      name: { type: "string", description: "The secret name in the vault (e.g. 'VERCEL_TOKEN', 'GITHUB_TOKEN')." },
    },
    required: ["name"],
  },
  async execute(args, signal) {
    try {
      signal?.throwIfAborted();
      const name = String(args.name ?? "").trim();
      if (!name) return fail("Missing 'name'.");

      // Lazy-load secrets module — keeps the clipboard tool decoupled when
      // the vault isn't initialized (test envs, CLI bootstrap, etc.)
      const { getSecretsStoreSingleton } = await import("./secrets.js");
      const store = getSecretsStoreSingleton();
      if (!store) return fail("Secrets vault not initialized.");
      const value = store.get(name);
      if (!value) return fail(`Secret "${name}" not found in vault. Capture it first via browser_capture_to_secret or the secret modal.`);

      // Belt-and-suspenders: register the value with the redactor so if it
      // EVER appears in subsequent tool output (snapshot, extract, page read),
      // sanitize.ts strips it before the model ingests the result.
      try {
        const { registerRedactedSecretValue } = await import("./sanitize.js");
        registerRedactedSecretValue(value);
      } catch { /* redactor optional */ }

      await run(["$input | Set-Clipboard"], value);
      // Deliberately do NOT include the value or any prefix in the response.
      // Length is a useful sanity check ("yes, something was copied") without
      // exposing the actual content.
      return ok(`Wrote secret "${name}" (${value.length} chars) to clipboard. The value never entered the chat context.`);
    } catch (e: unknown) {
      return fail(`Clipboard write from secret failed: ${(e as Error).message}`);
    }
  },
};

export const clipboardTools: ToolDefinition[] = [clipboardRead, clipboardWrite, clipboardWriteFromSecret];
export function createClipboardTools(): ToolDefinition[] {
  return clipboardTools;
}
