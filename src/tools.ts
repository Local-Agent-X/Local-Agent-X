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

// ── HTTP Request (Full API Integration) ──
// Created via factory so it can resolve {{SECRET_NAME}} placeholders from the secrets store.

import type { SecretsStore } from "./secrets.js";

export function createHttpRequestTool(secrets?: SecretsStore): ToolDefinition {
  return {
    name: "http_request",
    description:
      "Make a full HTTP request to any API. Supports all methods, custom headers, authentication, and request bodies. " +
      "Use {{SECRET_NAME}} syntax in header values to securely inject stored secrets (e.g. \"Authorization\": \"Bearer {{GITHUB_TOKEN}}\"). " +
      "Use request_secret first if the needed secret isn't stored yet. " +
      "Use this to integrate with external services (GitHub, Slack, Jira, Linear, Discord, REST/GraphQL APIs, etc.).",
    parameters: {
      type: "object",
      properties: {
        url: { type: "string", description: "Full URL to request" },
        method: {
          type: "string",
          description: "HTTP method: GET, POST, PUT, PATCH, DELETE, HEAD, OPTIONS (default: GET)",
        },
        headers: {
          type: "object",
          description:
            'Custom headers as key-value pairs. Use {{SECRET_NAME}} for stored secrets. Example: { "Authorization": "Bearer {{GITHUB_TOKEN}}" }',
        },
        body: {
          type: "string",
          description:
            "Request body as a string. Supports {{SECRET_NAME}} placeholders. For JSON APIs, pass a JSON string and set Content-Type header to application/json.",
        },
        timeout: {
          type: "number",
          description: "Timeout in milliseconds (default: 30000 = 30s, max: 120000 = 2min)",
        },
      },
      required: ["url"],
    },
    async execute(args) {
      const url = String(args.url);
      const method = String(args.method || "GET").toUpperCase();
      const timeout = Math.min((args.timeout as number) || 30_000, 120_000);

      const validMethods = ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"];
      if (!validMethods.includes(method)) {
        return err(`Invalid HTTP method: ${method}. Must be one of: ${validMethods.join(", ")}`);
      }

      // Build headers, resolving secret placeholders
      const headers: Record<string, string> = {
        "User-Agent": "SecretAgentX/0.1",
      };
      if (args.headers && typeof args.headers === "object") {
        for (const [key, value] of Object.entries(args.headers as Record<string, unknown>)) {
          let resolved = String(value);
          if (secrets) {
            // Check for missing secrets before resolving
            const missing = secrets.findMissing(resolved);
            if (missing.length > 0) {
              return err(
                `Missing secrets: ${missing.join(", ")}. Use request_secret to ask the user for these credentials first.`
              );
            }
            resolved = secrets.resolve(resolved);
          }
          headers[String(key)] = resolved;
        }
      }

      // Resolve secrets in body too
      let bodyStr = args.body ? String(args.body) : undefined;
      if (bodyStr && secrets) {
        const missing = secrets.findMissing(bodyStr);
        if (missing.length > 0) {
          return err(
            `Missing secrets in body: ${missing.join(", ")}. Use request_secret to ask the user for these credentials first.`
          );
        }
        bodyStr = secrets.resolve(bodyStr);
      }

      // Build fetch options
      const fetchOpts: RequestInit = {
        method,
        headers,
        signal: AbortSignal.timeout(timeout),
      };

      // Attach body for methods that support it
      if (bodyStr && method !== "GET" && method !== "HEAD") {
        fetchOpts.body = bodyStr;
        if (!headers["Content-Type"] && !headers["content-type"]) {
          headers["Content-Type"] = "application/json";
        }
      }

      try {
        const res = await fetch(url, fetchOpts);

        const statusLine = `${res.status} ${res.statusText}`;

        const resHeaders: string[] = [];
        res.headers.forEach((value, key) => {
          resHeaders.push(`${key}: ${value}`);
        });

        if (method === "HEAD") {
          return ok(`HTTP ${statusLine}\n\n${resHeaders.join("\n")}`);
        }

        let body = await res.text();

        const contentType = res.headers.get("content-type") || "";
        if (contentType.includes("application/json")) {
          try {
            body = JSON.stringify(JSON.parse(body), null, 2);
          } catch {
            // Keep raw body
          }
        }

        const MAX_CHARS = 100_000;
        if (body.length > MAX_CHARS) {
          body = body.slice(0, MAX_CHARS) + `\n\n[Truncated at ${MAX_CHARS} chars]`;
        }

        const output = `HTTP ${statusLine}\n\n${body}`;
        return res.ok ? ok(output) : err(output);
      } catch (e) {
        return err(`HTTP request failed: ${(e as Error).message}`);
      }
    },
  };
}

// ── Export All ──

export const allTools: ToolDefinition[] = [readTool, writeTool, editTool, bashTool, webFetchTool];
