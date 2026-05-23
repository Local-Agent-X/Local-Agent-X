import type { IntegrationConfig } from "../types.js";

export const instagramIntegration: IntegrationConfig = {
  id: "instagram",
  name: "Instagram",
  icon: "📷",
  description: "Publish media, read insights, manage Instagram via Meta's Graph API",
  authType: "bearer_token",
  authInstructions: "1. Go to developers.facebook.com\n2. Create an App (Business type)\n3. Add Instagram Graph API product\n4. Connect your Instagram Business/Creator account to a Facebook Page\n5. Generate token in Graph API Explorer with instagram_basic, instagram_content_publish\n6. Get your Instagram Business Account ID from /me/accounts → page_id → ?fields=instagram_business_account",
  baseUrl: "https://graph.facebook.com/v21.0",
  docsUrl: "https://developers.facebook.com/docs/instagram-api",
  secretName: "INSTAGRAM_ACCESS_TOKEN",
  scopes: ["instagram_basic", "instagram_content_publish", "instagram_manage_insights", "pages_show_list"],
  endpoints: [
    { name: "Get Profile", method: "GET", path: "/{ig_user_id}", description: "Get Instagram profile info", params: { fields: { type: "string", description: "username,media_count,followers_count,follows_count" } } },
    { name: "Get Media", method: "GET", path: "/{ig_user_id}/media", description: "List recent media posts", params: { fields: { type: "string", description: "id,caption,media_type,timestamp,permalink" } } },
    { name: "Create Media Container", method: "POST", path: "/{ig_user_id}/media", description: "Create a media container (step 1 of publish)", params: { image_url: { type: "string", required: true, description: "Public URL of the image" }, caption: { type: "string", description: "Post caption" } } },
    { name: "Publish Media", method: "POST", path: "/{ig_user_id}/media_publish", description: "Publish a media container (step 2)", params: { creation_id: { type: "string", required: true, description: "Container ID from Create Media" } } },
    { name: "Get Insights", method: "GET", path: "/{ig_user_id}/insights", description: "Account insights (reach, impressions)", params: { metric: { type: "string", required: true, description: "impressions,reach,follower_count" }, period: { type: "string", required: true, description: "day, week, days_28, month, lifetime" } } },
  ],
  headers: {},
  enabled: true,
  installed: false,
  builtin: true,
};
