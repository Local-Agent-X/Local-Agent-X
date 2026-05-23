import type { IntegrationConfig } from "../types.js";

export const slackIntegration: IntegrationConfig = {
  id: "slack",
  name: "Slack",
  icon: "💬",
  description: "Send messages, manage channels, upload files to Slack workspaces",
  authType: "bot_token",
  authInstructions: "1. Go to api.slack.com/apps\n2. Create New App → From Scratch\n3. Go to OAuth & Permissions\n4. Add scopes: chat:write, channels:read, files:write, users:read\n5. Install to workspace\n6. Copy Bot User OAuth Token (xoxb-...)",
  baseUrl: "https://slack.com/api",
  docsUrl: "https://api.slack.com/methods",
  secretName: "SLACK_BOT_TOKEN",
  scopes: ["chat:write", "channels:read", "files:write", "users:read"],
  endpoints: [
    { name: "Send Message", method: "POST", path: "/chat.postMessage", description: "Send a message to a channel", params: { channel: { type: "string", required: true, description: "Channel ID or name" }, text: { type: "string", required: true, description: "Message text" } } },
    { name: "List Channels", method: "GET", path: "/conversations.list", description: "List workspace channels", params: { types: { type: "string", description: "public_channel, private_channel" } } },
    { name: "Upload File", method: "POST", path: "/files.uploadV2", description: "Upload a file to Slack", params: { channel_id: { type: "string", required: true, description: "Channel to share in" }, filename: { type: "string", required: true, description: "Filename" }, content: { type: "string", required: true, description: "File content" } } },
    { name: "List Users", method: "GET", path: "/users.list", description: "List workspace members" },
    { name: "Set Status", method: "POST", path: "/users.profile.set", description: "Set your status", params: { profile: { type: "object", required: true, description: "Profile object with status_text and status_emoji" } } },
  ],
  headers: {},
  enabled: true,
  installed: false,
  builtin: true,
};
