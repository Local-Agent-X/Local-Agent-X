import type { IntegrationConfig } from "../types.js";

export const twitterIntegration: IntegrationConfig = {
  id: "twitter",
  name: "Twitter / X",
  icon: "🐦",
  description: "Post tweets, read timelines, manage followers on X (Twitter)",
  authType: "bearer_token",
  authInstructions: "1. Go to developer.x.com\n2. Sign up for a developer account\n3. Create a Project and App\n4. Generate Bearer Token (for read-only) or OAuth 2.0 tokens (for posting)\n5. Copy your Bearer Token",
  baseUrl: "https://api.x.com/2",
  docsUrl: "https://developer.x.com/en/docs/x-api",
  secretName: "TWITTER_BEARER_TOKEN",
  scopes: ["tweet.read", "tweet.write", "users.read"],
  endpoints: [
    { name: "Post Tweet", method: "POST", path: "/tweets", description: "Create a new tweet", params: { text: { type: "string", required: true, description: "Tweet text (280 char limit)" } } },
    { name: "Get User Tweets", method: "GET", path: "/users/{id}/tweets", description: "Get tweets by user ID", params: { max_results: { type: "number", description: "Max tweets (5-100)" } } },
    { name: "Search Tweets", method: "GET", path: "/tweets/search/recent", description: "Search recent tweets", params: { query: { type: "string", required: true, description: "Search query" }, max_results: { type: "number", description: "Max results (10-100)" } } },
    { name: "Get User By Username", method: "GET", path: "/users/by/username/{username}", description: "Look up user by handle" },
    { name: "Get Me", method: "GET", path: "/users/me", description: "Get authenticated user info" },
  ],
  headers: {},
  enabled: true,
  installed: false,
  builtin: true,
};
