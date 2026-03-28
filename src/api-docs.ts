// ── REST API Documentation ── Auto-generate OpenAPI 3.0 spec

export interface ApiParameter {
  name: string;
  in: "query" | "path" | "header";
  description?: string;
  required?: boolean;
  schema: { type: string; enum?: string[]; default?: unknown };
}

export interface ApiRequestBody {
  description?: string;
  required?: boolean;
  content: {
    [mediaType: string]: {
      schema: Record<string, unknown>;
    };
  };
}

export interface ApiResponseDef {
  description: string;
  content?: {
    [mediaType: string]: {
      schema: Record<string, unknown>;
    };
  };
}

export interface ApiRoute {
  method: "get" | "post" | "put" | "delete" | "patch";
  path: string;
  description: string;
  summary?: string;
  tags?: string[];
  parameters?: ApiParameter[];
  requestBody?: ApiRequestBody;
  responses: { [statusCode: string]: ApiResponseDef };
}

interface OpenApiSpec {
  openapi: string;
  info: { title: string; version: string; description: string };
  servers: { url: string; description: string }[];
  paths: Record<string, Record<string, unknown>>;
  tags: { name: string; description: string }[];
}

export function generateApiSpec(
  routes: ApiRoute[],
  options?: { title?: string; version?: string; description?: string; serverUrl?: string }
): OpenApiSpec {
  const title = options?.title ?? "Open Agent X API";
  const version = options?.version ?? "1.0.0";
  const description = options?.description ?? "REST API for the Open Agent X platform";
  const serverUrl = options?.serverUrl ?? "http://localhost:3131";

  // Collect unique tags
  const tagSet = new Set<string>();
  for (const route of routes) {
    if (route.tags) {
      for (const tag of route.tags) tagSet.add(tag);
    }
  }

  // Build paths
  const paths: Record<string, Record<string, unknown>> = {};

  for (const route of routes) {
    if (!paths[route.path]) {
      paths[route.path] = {};
    }

    const operation: Record<string, unknown> = {
      summary: route.summary ?? route.description,
      description: route.description,
      responses: route.responses,
    };

    if (route.tags && route.tags.length > 0) {
      operation.tags = route.tags;
    }

    if (route.parameters && route.parameters.length > 0) {
      operation.parameters = route.parameters;
    }

    if (route.requestBody) {
      operation.requestBody = route.requestBody;
    }

    paths[route.path][route.method] = operation;
  }

  const tags = [...tagSet].map((name) => ({ name, description: `${name} endpoints` }));

  return {
    openapi: "3.0.3",
    info: { title, version, description },
    servers: [{ url: serverUrl, description: "Local development server" }],
    paths,
    tags,
  };
}

// ── Built-in route definitions for Open Agent X ──

export const builtinRoutes: ApiRoute[] = [
  // Chat
  {
    method: "post",
    path: "/api/chat",
    description: "Send a chat message and receive a streaming response via SSE",
    tags: ["chat"],
    requestBody: {
      required: true,
      content: {
        "application/json": {
          schema: {
            type: "object",
            properties: {
              message: { type: "string" },
              sessionId: { type: "string" },
            },
            required: ["message"],
          },
        },
      },
    },
    responses: {
      "200": { description: "SSE stream of ServerEvent objects" },
      "401": { description: "Unauthorized" },
    },
  },
  {
    method: "post",
    path: "/api/chat/abort",
    description: "Abort the currently running chat request",
    tags: ["chat"],
    responses: {
      "200": { description: "Abort acknowledged" },
    },
  },

  // Voice
  {
    method: "post",
    path: "/api/voice/tts",
    description: "Convert text to speech audio",
    tags: ["voice"],
    requestBody: {
      required: true,
      content: {
        "application/json": {
          schema: {
            type: "object",
            properties: {
              text: { type: "string" },
              voice: { type: "string" },
            },
            required: ["text"],
          },
        },
      },
    },
    responses: {
      "200": {
        description: "Audio data",
        content: { "audio/wav": { schema: { type: "string", format: "binary" } } },
      },
    },
  },
  {
    method: "post",
    path: "/api/voice/stt",
    description: "Convert speech audio to text",
    tags: ["voice"],
    requestBody: {
      required: true,
      content: {
        "audio/wav": { schema: { type: "string", format: "binary" } },
      },
    },
    responses: {
      "200": {
        description: "Transcribed text",
        content: {
          "application/json": {
            schema: { type: "object", properties: { text: { type: "string" } } },
          },
        },
      },
    },
  },

  // Sessions
  {
    method: "get",
    path: "/api/sessions",
    description: "List all chat sessions",
    tags: ["sessions"],
    responses: {
      "200": {
        description: "Array of session objects",
        content: {
          "application/json": {
            schema: { type: "array", items: { type: "object" } },
          },
        },
      },
    },
  },
  {
    method: "post",
    path: "/api/sessions",
    description: "Create a new chat session",
    tags: ["sessions"],
    requestBody: {
      content: {
        "application/json": {
          schema: {
            type: "object",
            properties: { title: { type: "string" } },
          },
        },
      },
    },
    responses: {
      "201": { description: "Created session object" },
    },
  },
  {
    method: "delete",
    path: "/api/sessions/{id}",
    description: "Delete a chat session by ID",
    tags: ["sessions"],
    parameters: [
      { name: "id", in: "path", required: true, schema: { type: "string" } },
    ],
    responses: {
      "204": { description: "Session deleted" },
      "404": { description: "Session not found" },
    },
  },

  // Security
  {
    method: "get",
    path: "/api/security/audit",
    description: "Retrieve the security audit log",
    tags: ["security"],
    parameters: [
      { name: "limit", in: "query", schema: { type: "integer", default: 50 } },
    ],
    responses: {
      "200": { description: "Array of audit entries" },
    },
  },
  {
    method: "get",
    path: "/api/auth/status",
    description: "Check current authentication status",
    tags: ["security"],
    responses: {
      "200": {
        description: "Auth status",
        content: {
          "application/json": {
            schema: {
              type: "object",
              properties: { authenticated: { type: "boolean" } },
            },
          },
        },
      },
    },
  },

  // Tools
  {
    method: "get",
    path: "/api/tools",
    description: "List all available tools",
    tags: ["tools"],
    responses: {
      "200": {
        description: "Array of tool definitions",
        content: {
          "application/json": {
            schema: { type: "array", items: { type: "object" } },
          },
        },
      },
    },
  },
  {
    method: "post",
    path: "/api/tools/{name}/run",
    description: "Execute a tool by name",
    tags: ["tools"],
    parameters: [
      { name: "name", in: "path", required: true, schema: { type: "string" } },
    ],
    requestBody: {
      required: true,
      content: {
        "application/json": {
          schema: { type: "object", additionalProperties: true },
        },
      },
    },
    responses: {
      "200": { description: "Tool execution result" },
      "404": { description: "Tool not found" },
    },
  },
];

export function generateFullSpec(
  extraRoutes?: ApiRoute[],
  options?: Parameters<typeof generateApiSpec>[1]
): OpenApiSpec {
  const allRoutes = [...builtinRoutes, ...(extraRoutes ?? [])];
  return generateApiSpec(allRoutes, options);
}
