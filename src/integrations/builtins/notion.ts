import type { IntegrationConfig } from "../types.js";

export const notionIntegration: IntegrationConfig = {
  id: "notion",
  name: "Notion",
  icon: "📝",
  description: "Databases, pages, blocks — manage your Notion workspace",
  authType: "bearer_token",
  authInstructions: "1. Go to notion.so/my-integrations\n2. Create New Integration\n3. Give it a name and select your workspace\n4. Copy the Internal Integration Secret\n5. In Notion, share the pages/databases you want accessible with your integration",
  baseUrl: "https://api.notion.com/v1",
  docsUrl: "https://developers.notion.com/reference",
  secretName: "NOTION_API_KEY",
  endpoints: [
    { name: "Search", method: "POST", path: "/search", description: "Search pages and databases", params: { query: { type: "string", description: "Search text" }, filter: { type: "object", description: "Filter by page or database" } } },
    { name: "Query Database", method: "POST", path: "/databases/{database_id}/query", description: "Query a Notion database", params: { filter: { type: "object", description: "Filter conditions" }, sorts: { type: "array", description: "Sort criteria" } } },
    { name: "Create Page", method: "POST", path: "/pages", description: "Create a new page", params: { parent: { type: "object", required: true, description: "Parent database or page" }, properties: { type: "object", required: true, description: "Page properties" } } },
    { name: "Get Page", method: "GET", path: "/pages/{page_id}", description: "Retrieve a page" },
    { name: "Update Page", method: "PATCH", path: "/pages/{page_id}", description: "Update page properties", params: { properties: { type: "object", required: true, description: "Properties to update" } } },
    { name: "List Databases", method: "POST", path: "/search", description: "List all databases", params: { filter: { type: "object", description: '{ "property": "object", "value": "database" }' } } },
  ],
  headers: { "Notion-Version": "2022-06-28" },
  enabled: true,
  installed: false,
  builtin: true,
};
