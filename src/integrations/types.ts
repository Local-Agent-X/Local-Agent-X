export interface IntegrationEndpoint {
  name: string;
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  path: string;
  description: string;
  params?: Record<string, { type: string; required?: boolean; description: string }>;
}

export interface IntegrationConfig {
  id: string;
  name: string;
  icon: string;
  description: string;
  authType: "oauth2" | "api_key" | "bearer_token" | "bot_token";
  authInstructions: string;
  baseUrl: string;
  docsUrl: string;
  secretName: string;
  scopes?: string[];
  endpoints: IntegrationEndpoint[];
  headers?: Record<string, string>;
  enabled: boolean;
  installed: boolean;
  builtin: boolean;
}
