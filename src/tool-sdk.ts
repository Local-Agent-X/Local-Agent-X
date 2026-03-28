// ── Tool SDK ── Simple API for writing custom tools

export interface ToolParameter {
  type: string;
  description?: string;
  enum?: string[];
  default?: unknown;
}

export interface ToolSchema {
  type: "object";
  properties: Record<string, ToolParameter>;
  required: string[];
}

export interface ToolConfig {
  name: string;
  description: string;
  parameters: ToolSchema;
  execute: (args: Record<string, unknown>) => Promise<ToolOutput>;
}

export interface ToolOutput {
  content: string;
  isError?: boolean;
  metadata?: Record<string, unknown>;
}

interface BuiltTool {
  name: string;
  description: string;
  parameters: ToolSchema;
  execute: (args: Record<string, unknown>) => Promise<ToolOutput>;
}

function validateToolConfig(config: ToolConfig): string[] {
  const errors: string[] = [];

  if (!config.name || typeof config.name !== "string") {
    errors.push("Tool name is required and must be a non-empty string.");
  } else if (!/^[a-z][a-z0-9_-]*$/.test(config.name)) {
    errors.push(
      `Tool name "${config.name}" is invalid. ` +
        "Use lowercase letters, numbers, hyphens, or underscores. Must start with a letter."
    );
  }

  if (!config.description || typeof config.description !== "string") {
    errors.push("Tool description is required and must be a non-empty string.");
  }

  if (!config.parameters || typeof config.parameters !== "object") {
    errors.push("Tool parameters must be an object with type, properties, and required fields.");
  } else {
    if (config.parameters.type !== "object") {
      errors.push('Parameters.type must be "object".');
    }
    if (!config.parameters.properties || typeof config.parameters.properties !== "object") {
      errors.push("Parameters.properties must be an object.");
    }
    if (!Array.isArray(config.parameters.required)) {
      errors.push("Parameters.required must be an array of strings.");
    }
  }

  if (typeof config.execute !== "function") {
    errors.push("Tool execute must be a function.");
  }

  return errors;
}

export function defineTool(config: ToolConfig): BuiltTool {
  const errors = validateToolConfig(config);
  if (errors.length > 0) {
    throw new Error(`Invalid tool definition:\n  - ${errors.join("\n  - ")}`);
  }

  return {
    name: config.name,
    description: config.description,
    parameters: { ...config.parameters },
    execute: async (args: Record<string, unknown>) => {
      // Validate required parameters before execution
      for (const req of config.parameters.required) {
        if (args[req] === undefined || args[req] === null) {
          return { content: `Missing required parameter: ${req}`, isError: true };
        }
      }
      try {
        return await config.execute(args);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return { content: `Tool execution failed: ${msg}`, isError: true };
      }
    },
  };
}

export class ToolBuilder {
  private config: Partial<ToolConfig> = {
    parameters: { type: "object", properties: {}, required: [] },
  };

  name(name: string): this {
    this.config.name = name;
    return this;
  }

  description(desc: string): this {
    this.config.description = desc;
    return this;
  }

  parameter(
    name: string,
    opts: ToolParameter & { required?: boolean }
  ): this {
    const params = this.config.parameters!;
    params.properties[name] = {
      type: opts.type,
      description: opts.description,
      enum: opts.enum,
      default: opts.default,
    };
    if (opts.required) {
      params.required.push(name);
    }
    return this;
  }

  execute(fn: (args: Record<string, unknown>) => Promise<ToolOutput>): this {
    this.config.execute = fn;
    return this;
  }

  build(): BuiltTool {
    return defineTool(this.config as ToolConfig);
  }
}

// ── Example Templates ──

export const templates = {
  apiCaller: (): ToolBuilder =>
    new ToolBuilder()
      .name("api-caller")
      .description("Call an external REST API endpoint")
      .parameter("url", { type: "string", description: "The URL to call", required: true })
      .parameter("method", {
        type: "string",
        description: "HTTP method",
        enum: ["GET", "POST", "PUT", "DELETE"],
        default: "GET",
      })
      .parameter("body", { type: "string", description: "Request body (JSON string)" })
      .execute(async (args) => {
        const url = args.url as string;
        const method = (args.method as string) || "GET";
        const body = args.body as string | undefined;
        const res = await fetch(url, {
          method,
          headers: body ? { "Content-Type": "application/json" } : undefined,
          body,
        });
        const text = await res.text();
        return { content: text, metadata: { status: res.status } };
      }),

  fileProcessor: (): ToolBuilder =>
    new ToolBuilder()
      .name("file-processor")
      .description("Read and process a local file")
      .parameter("path", { type: "string", description: "Absolute file path", required: true })
      .parameter("encoding", { type: "string", description: "File encoding", default: "utf-8" })
      .execute(async (args) => {
        const { readFile } = await import("node:fs/promises");
        const content = await readFile(args.path as string, {
          encoding: (args.encoding as BufferEncoding) || "utf-8",
        });
        return { content, metadata: { length: content.length } };
      }),

  webScraper: (): ToolBuilder =>
    new ToolBuilder()
      .name("web-scraper")
      .description("Fetch a web page and return its text content")
      .parameter("url", { type: "string", description: "URL to fetch", required: true })
      .execute(async (args) => {
        const res = await fetch(args.url as string);
        const html = await res.text();
        // Strip HTML tags for plain text
        const text = html.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
        return { content: text, metadata: { status: res.status, rawLength: html.length } };
      }),
};
