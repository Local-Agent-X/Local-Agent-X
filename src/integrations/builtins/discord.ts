import type { IntegrationConfig } from "../types.js";

export const discordIntegration: IntegrationConfig = {
  id: "discord",
  name: "Discord",
  icon: "🎮",
  description: "Send messages, manage servers, and interact with Discord communities",
  authType: "bot_token",
  authInstructions: "1. Go to discord.com/developers/applications\n2. Create New Application\n3. Go to Bot tab → Reset Token\n4. Copy the bot token\n5. Go to OAuth2 → URL Generator → Select 'bot' scope\n6. Add bot to your server with the generated URL",
  baseUrl: "https://discord.com/api/v10",
  docsUrl: "https://discord.com/developers/docs/reference",
  secretName: "DISCORD_BOT_TOKEN",
  endpoints: [
    { name: "Send Message", method: "POST", path: "/channels/{channel_id}/messages", description: "Send a message to a channel", params: { content: { type: "string", required: true, description: "Message content" } } },
    { name: "List Guilds", method: "GET", path: "/users/@me/guilds", description: "List servers the bot is in" },
    { name: "List Channels", method: "GET", path: "/guilds/{guild_id}/channels", description: "List channels in a server" },
    { name: "Get User", method: "GET", path: "/users/@me", description: "Get bot user info" },
    { name: "Create Reaction", method: "PUT", path: "/channels/{channel_id}/messages/{message_id}/reactions/{emoji}/@me", description: "Add a reaction to a message" },
  ],
  headers: {},
  enabled: true,
  installed: false,
  builtin: true,
};
