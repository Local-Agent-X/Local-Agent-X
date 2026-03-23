import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { execSync } from "node:child_process";
import { resolve, dirname } from "node:path";
import type { ToolDefinition, ToolResult } from "./types.js";

function ok(content: string): ToolResult {
  return { content };
}

function err(content: string): ToolResult {
  return { content, isError: true };
}

// ── Read File ──

const readTool: ToolDefinition = {
  name: "read",
  description:
    "Read a file from the filesystem. Returns the file contents with line numbers. Use offset and limit for large files.",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "File path to read" },
      offset: { type: "number", description: "Line number to start from (1-based)" },
      limit: { type: "number", description: "Max number of lines to return" },
    },
    required: ["path"],
  },
  async execute(args) {
    const filePath = resolve(String(args.path));
    if (!existsSync(filePath)) return err(`File not found: ${filePath}`);

    try {
      const content = readFileSync(filePath, "utf-8");
      const lines = content.split("\n");
      const offset = Math.max(0, ((args.offset as number) || 1) - 1);
      const limit = (args.limit as number) || lines.length;
      const slice = lines.slice(offset, offset + limit);
      const numbered = slice.map((line, i) => `${offset + i + 1}\t${line}`).join("\n");
      const total = lines.length;
      const shown = slice.length;
      const header = shown < total ? `[Lines ${offset + 1}-${offset + shown} of ${total}]\n` : "";
      return ok(header + numbered);
    } catch (e) {
      return err(`Failed to read ${filePath}: ${(e as Error).message}`);
    }
  },
};

// ── Write File ──

const writeTool: ToolDefinition = {
  name: "write",
  description: "Write content to a file. Creates the file and parent directories if they don't exist.",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "File path to write" },
      content: { type: "string", description: "Content to write" },
    },
    required: ["path", "content"],
  },
  async execute(args) {
    const filePath = resolve(String(args.path));
    try {
      mkdirSync(dirname(filePath), { recursive: true });
      writeFileSync(filePath, String(args.content), "utf-8");
      return ok(`Wrote ${filePath}`);
    } catch (e) {
      return err(`Failed to write ${filePath}: ${(e as Error).message}`);
    }
  },
};

// ── Edit File ──

const editTool: ToolDefinition = {
  name: "edit",
  description:
    "Edit a file by replacing an exact string match. The old_string must match exactly (including whitespace). Use this for targeted changes.",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "File path to edit" },
      old_string: { type: "string", description: "Exact string to find and replace" },
      new_string: { type: "string", description: "Replacement string" },
    },
    required: ["path", "old_string", "new_string"],
  },
  async execute(args) {
    const filePath = resolve(String(args.path));
    if (!existsSync(filePath)) return err(`File not found: ${filePath}`);

    try {
      const content = readFileSync(filePath, "utf-8");
      const oldStr = String(args.old_string);
      const newStr = String(args.new_string);

      if (!content.includes(oldStr)) {
        return err(`old_string not found in ${filePath}. Make sure it matches exactly.`);
      }

      const occurrences = content.split(oldStr).length - 1;
      if (occurrences > 1) {
        return err(
          `old_string found ${occurrences} times in ${filePath}. Provide more context to make it unique.`
        );
      }

      const updated = content.replace(oldStr, newStr);
      writeFileSync(filePath, updated, "utf-8");
      return ok(`Edited ${filePath}`);
    } catch (e) {
      return err(`Failed to edit ${filePath}: ${(e as Error).message}`);
    }
  },
};

// ── Bash ──

const bashTool: ToolDefinition = {
  name: "bash",
  description:
    "Execute a shell command and return its output. Use for running scripts, installing packages, git operations, etc.",
  parameters: {
    type: "object",
    properties: {
      command: { type: "string", description: "The shell command to execute" },
      timeout: {
        type: "number",
        description: "Timeout in milliseconds (default 120000 = 2 min)",
      },
    },
    required: ["command"],
  },
  async execute(args) {
    const command = String(args.command);
    const timeout = (args.timeout as number) || 120_000;

    try {
      const output = execSync(command, {
        encoding: "utf-8",
        timeout,
        maxBuffer: 1024 * 1024 * 10, // 10MB
        shell: process.platform === "win32" ? "powershell.exe" : "/bin/bash",
      });
      return ok(output || "(no output)");
    } catch (e) {
      const error = e as { stdout?: string; stderr?: string; message: string };
      const output = [error.stdout, error.stderr].filter(Boolean).join("\n");
      return err(output || error.message);
    }
  },
};

// ── Web Fetch ──

const webFetchTool: ToolDefinition = {
  name: "web_fetch",
  description: "Fetch a URL and return its text content. Useful for reading web pages and APIs.",
  parameters: {
    type: "object",
    properties: {
      url: { type: "string", description: "URL to fetch" },
    },
    required: ["url"],
  },
  async execute(args) {
    const url = String(args.url);

    try {
      const res = await fetch(url, {
        headers: {
          "User-Agent": "SecretAgentX/0.1",
          Accept: "text/html,application/json,text/plain",
        },
        signal: AbortSignal.timeout(30_000),
      });

      if (!res.ok) {
        return err(`HTTP ${res.status}: ${res.statusText}`);
      }

      let body = await res.text();

      // Truncate large responses
      const MAX_CHARS = 50_000;
      if (body.length > MAX_CHARS) {
        body = body.slice(0, MAX_CHARS) + `\n\n[Truncated at ${MAX_CHARS} chars]`;
      }

      return ok(body);
    } catch (e) {
      return err(`Fetch failed: ${(e as Error).message}`);
    }
  },
};

// ── Export All ──

export const allTools: ToolDefinition[] = [readTool, writeTool, editTool, bashTool, webFetchTool];
