import type { IntegrationConfig } from "../types.js";

export const facebookIntegration: IntegrationConfig = {
  id: "facebook",
  name: "Facebook",
  icon: "📘",
  description: "Pages, posts, insights — Meta's Graph API for Facebook",
  authType: "bearer_token",
  authInstructions: "1. Go to developers.facebook.com\n2. Create an App (Business type)\n3. Add Facebook Login product\n4. Go to Graph API Explorer\n5. Generate a User Access Token with pages_manage_posts, pages_read_engagement\n6. For long-lived tokens: exchange via /oauth/access_token",
  baseUrl: "https://graph.facebook.com/v21.0",
  docsUrl: "https://developers.facebook.com/docs/graph-api",
  secretName: "FACEBOOK_ACCESS_TOKEN",
  scopes: ["pages_manage_posts", "pages_read_engagement", "pages_read_user_content"],
  endpoints: [
    { name: "Get My Pages", method: "GET", path: "/me/accounts", description: "List Facebook pages you manage" },
    { name: "Post to Page", method: "POST", path: "/{page_id}/feed", description: "Create a post on a Facebook page", params: { message: { type: "string", required: true, description: "Post text" }, link: { type: "string", description: "URL to share" } } },
    { name: "Get Page Posts", method: "GET", path: "/{page_id}/posts", description: "Get posts from a page", params: { limit: { type: "number", description: "Number of posts" } } },
    { name: "Get Post Insights", method: "GET", path: "/{post_id}/insights", description: "Get engagement metrics for a post" },
    { name: "Get My Profile", method: "GET", path: "/me", description: "Get your Facebook profile", params: { fields: { type: "string", description: "Comma-separated fields (name,email,picture)" } } },
  ],
  headers: {},
  enabled: true,
  installed: false,
  builtin: true,
};
