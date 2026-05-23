import type { IntegrationConfig } from "../types.js";

export const ebayIntegration: IntegrationConfig = {
  id: "ebay",
  name: "eBay",
  icon: "🛒",
  description: "Search listings, manage orders, track items on eBay",
  authType: "bearer_token",
  authInstructions: "1. Go to developer.ebay.com\n2. Create an Application (Production or Sandbox)\n3. Get your App ID (Client ID) and Cert ID (Client Secret)\n4. Use Client Credentials grant to get an Application token\n5. For user-level access (selling): use Authorization Code grant",
  baseUrl: "https://api.ebay.com",
  docsUrl: "https://developer.ebay.com/docs",
  secretName: "EBAY_ACCESS_TOKEN",
  scopes: ["https://api.ebay.com/oauth/api_scope", "https://api.ebay.com/oauth/api_scope/sell.inventory"],
  endpoints: [
    { name: "Search Items", method: "GET", path: "/buy/browse/v1/item_summary/search", description: "Search for items on eBay", params: { q: { type: "string", required: true, description: "Search keywords" }, limit: { type: "number", description: "Max results (1-200)" }, filter: { type: "string", description: "Filter string (price, condition, etc.)" } } },
    { name: "Get Item", method: "GET", path: "/buy/browse/v1/item/{item_id}", description: "Get full details for an item" },
    { name: "Get Orders", method: "GET", path: "/sell/fulfillment/v1/order", description: "List your sell orders", params: { limit: { type: "number", description: "Max results" }, filter: { type: "string", description: "Order status filter" } } },
    { name: "Get My Items", method: "GET", path: "/sell/inventory/v1/inventory_item", description: "List your inventory items", params: { limit: { type: "number", description: "Max results" }, offset: { type: "number", description: "Pagination offset" } } },
  ],
  headers: { "X-EBAY-C-MARKETPLACE-ID": "EBAY_US" },
  enabled: true,
  installed: false,
  builtin: true,
};
