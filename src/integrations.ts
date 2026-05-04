/**
 * API Integrations Registry
 *
 * Manages third-party API integrations for Local Agent X.
 * - 10 built-in integrations (Google, GitHub, Slack, Discord, Twitter/X, Facebook, Instagram, Spotify, eBay, Notion)
 * - Dynamic discovery: agent can search for and install new integrations
 * - All API keys/tokens stored in the encrypted secrets vault (never in this file)
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";

// ── Types ──

export interface IntegrationEndpoint {
  name: string;
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  path: string;           // e.g. "/v1/messages" — appended to baseUrl
  description: string;
  params?: Record<string, { type: string; required?: boolean; description: string }>;
}

export interface IntegrationConfig {
  id: string;              // unique slug: "google", "github", "slack"
  name: string;            // display name
  icon: string;            // emoji icon
  description: string;
  authType: "oauth2" | "api_key" | "bearer_token" | "bot_token";
  authInstructions: string; // how to get credentials
  baseUrl: string;
  docsUrl: string;          // link to official API docs
  secretName: string;       // key in secrets vault, e.g. "GOOGLE_API_KEY"
  scopes?: string[];        // OAuth scopes if applicable
  endpoints: IntegrationEndpoint[];
  headers?: Record<string, string>; // extra headers to include
  enabled: boolean;
  installed: boolean;       // user has configured credentials
  builtin: boolean;         // true = shipped with the app, false = user-added
}

// ── Built-in Integrations ──

const BUILTIN_INTEGRATIONS: IntegrationConfig[] = [
  {
    id: "google",
    name: "Google",
    icon: "🔍",
    description: "Gmail, Calendar, Drive, YouTube — Google's full API suite",
    authType: "api_key",
    authInstructions: "1. Go to console.cloud.google.com\n2. Create a project\n3. Enable APIs (YouTube Data API v3, etc.)\n4. Create credentials → API key\n5. Copy the API key",
    baseUrl: "https://www.googleapis.com",
    docsUrl: "https://developers.google.com/apis-explorer",
    secretName: "GOOGLE_API_KEY",
    scopes: ["https://www.googleapis.com/auth/gmail.modify", "https://www.googleapis.com/auth/calendar", "https://www.googleapis.com/auth/drive"],
    endpoints: [
      { name: "List Emails", method: "GET", path: "/gmail/v1/users/me/messages", description: "List Gmail messages", params: { q: { type: "string", description: "Search query (same as Gmail search)" }, maxResults: { type: "number", description: "Max results (default 10)" } } },
      { name: "Send Email", method: "POST", path: "/gmail/v1/users/me/messages/send", description: "Send an email via Gmail", params: { raw: { type: "string", required: true, description: "Base64url encoded email (RFC 2822)" } } },
      { name: "List Calendar Events", method: "GET", path: "/calendar/v3/calendars/primary/events", description: "Get upcoming calendar events", params: { timeMin: { type: "string", description: "Start time (ISO 8601)" }, maxResults: { type: "number", description: "Max events" } } },
      { name: "Create Calendar Event", method: "POST", path: "/calendar/v3/calendars/primary/events", description: "Create a new calendar event", params: { summary: { type: "string", required: true, description: "Event title" }, start: { type: "object", required: true, description: "Start time object" }, end: { type: "object", required: true, description: "End time object" } } },
      { name: "List Drive Files", method: "GET", path: "/drive/v3/files", description: "List files in Google Drive", params: { q: { type: "string", description: "Search query" }, pageSize: { type: "number", description: "Max files" } } },
      { name: "Search YouTube", method: "GET", path: "/youtube/v3/search", description: "Search YouTube videos", params: { q: { type: "string", required: true, description: "Search query" }, maxResults: { type: "number", description: "Max results" }, type: { type: "string", description: "video, channel, or playlist" } } },
    ],
    headers: {},
    enabled: true,
    installed: false,
    builtin: true,
  },
  {
    id: "github",
    name: "GitHub",
    icon: "🐙",
    description: "Repos, issues, PRs, actions — full GitHub API",
    authType: "bearer_token",
    authInstructions: "1. Go to github.com/settings/tokens\n2. Generate new token (classic or fine-grained)\n3. Select scopes: repo, read:user\n4. Copy the token",
    baseUrl: "https://api.github.com",
    docsUrl: "https://docs.github.com/en/rest",
    secretName: "GITHUB_TOKEN",
    scopes: ["repo", "read:user"],
    endpoints: [
      { name: "List Repos", method: "GET", path: "/user/repos", description: "List your repositories", params: { sort: { type: "string", description: "created, updated, pushed, full_name" }, per_page: { type: "number", description: "Results per page (max 100)" } } },
      { name: "Create Issue", method: "POST", path: "/repos/{owner}/{repo}/issues", description: "Create an issue", params: { title: { type: "string", required: true, description: "Issue title" }, body: { type: "string", description: "Issue body (markdown)" } } },
      { name: "List PRs", method: "GET", path: "/repos/{owner}/{repo}/pulls", description: "List pull requests", params: { state: { type: "string", description: "open, closed, all" } } },
      { name: "Create PR", method: "POST", path: "/repos/{owner}/{repo}/pulls", description: "Create a pull request", params: { title: { type: "string", required: true, description: "PR title" }, head: { type: "string", required: true, description: "Branch with changes" }, base: { type: "string", required: true, description: "Branch to merge into" } } },
      { name: "Get User", method: "GET", path: "/user", description: "Get authenticated user profile" },
      { name: "List Notifications", method: "GET", path: "/notifications", description: "List notifications" },
    ],
    headers: { "Accept": "application/vnd.github.v3+json" },
    enabled: true,
    installed: false,
    builtin: true,
  },
  {
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
  },
  {
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
  },
  {
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
  },
  {
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
  },
  {
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
  },
  {
    id: "spotify",
    name: "Spotify",
    icon: "🎵",
    description: "Search music, control playback, manage playlists on Spotify",
    authType: "bearer_token",
    authInstructions: "1. Go to developer.spotify.com/dashboard\n2. Create an App\n3. Copy Client ID + Client Secret\n4. For user-level access: use Authorization Code flow\n5. For search-only: use Client Credentials flow to get Bearer token",
    baseUrl: "https://api.spotify.com/v1",
    docsUrl: "https://developer.spotify.com/documentation/web-api",
    secretName: "SPOTIFY_ACCESS_TOKEN",
    scopes: ["user-read-playback-state", "user-modify-playback-state", "playlist-modify-public", "user-library-read"],
    endpoints: [
      { name: "Search", method: "GET", path: "/search", description: "Search for tracks, artists, albums, playlists", params: { q: { type: "string", required: true, description: "Search query" }, type: { type: "string", required: true, description: "track,artist,album,playlist" }, limit: { type: "number", description: "Max results (1-50)" } } },
      { name: "Get Playback", method: "GET", path: "/me/player", description: "Get current playback state" },
      { name: "Play Track", method: "PUT", path: "/me/player/play", description: "Start/resume playback", params: { uris: { type: "array", description: "Spotify track URIs to play" } } },
      { name: "Get Playlists", method: "GET", path: "/me/playlists", description: "List your playlists", params: { limit: { type: "number", description: "Max results" } } },
      { name: "Add to Playlist", method: "POST", path: "/playlists/{playlist_id}/tracks", description: "Add tracks to a playlist", params: { uris: { type: "array", required: true, description: "Array of Spotify track URIs" } } },
      { name: "Get Recommendations", method: "GET", path: "/recommendations", description: "Get track recommendations", params: { seed_tracks: { type: "string", description: "Comma-separated track IDs" }, seed_artists: { type: "string", description: "Comma-separated artist IDs" }, seed_genres: { type: "string", description: "Comma-separated genre names" } } },
    ],
    headers: {},
    enabled: true,
    installed: false,
    builtin: true,
  },
  {
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
  },
  {
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
  },
  {
    id: "whatsapp",
    name: "WhatsApp",
    icon: "💬",
    description: "Chat with your agent from anywhere via WhatsApp — just scan a QR code to connect",
    authType: "api_key",
    authInstructions: "No API keys needed! Just:\n1. Go to Settings → WhatsApp\n2. Click Connect\n3. Scan the QR code with WhatsApp on your phone (Linked Devices → Link a Device)\n4. Done — message yourself to talk to your agent",
    baseUrl: "http://localhost",
    docsUrl: "https://github.com/WhiskeySockets/Baileys",
    secretName: "WHATSAPP_CONNECTED",
    endpoints: [
      { name: "Connect", method: "POST", path: "/api/whatsapp/connect", description: "Start connection and get QR code" },
      { name: "Status", method: "GET", path: "/api/whatsapp/status", description: "Check connection status" },
      { name: "Send Message", method: "POST", path: "/api/whatsapp/send", description: "Send a message to a WhatsApp number", params: { to: { type: "string", required: true, description: "Phone number with country code" }, message: { type: "string", required: true, description: "Message text" } } },
      { name: "Disconnect", method: "POST", path: "/api/whatsapp/disconnect", description: "Disconnect WhatsApp" },
    ],
    headers: {},
    enabled: true,
    installed: false,
    builtin: true,
  },
  {
    id: "email",
    name: "Email (SMTP/IMAP)",
    icon: "📧",
    description: "Send and read emails — works with Gmail, Outlook, Yahoo, or any email provider",
    authType: "api_key",
    authInstructions: "Gmail setup (recommended):\n1. Go to myaccount.google.com → Security\n2. Enable 2-Step Verification (required)\n3. Go to myaccount.google.com/apppasswords\n4. Create an App Password (select 'Mail')\n5. Fill in these 5 values below:\n\n• SMTP_HOST = smtp.gmail.com\n• SMTP_PORT = 587\n• SMTP_USER = your.email@gmail.com\n• SMTP_PASS = (the 16-char app password)\n• SMTP_FROM = your.email@gmail.com\n\nFor reading emails, also set:\n• IMAP_HOST = imap.gmail.com\n• IMAP_PORT = 993\n• IMAP_USER = your.email@gmail.com\n• IMAP_PASS = (same app password)\n\nOutlook: use smtp-mail.outlook.com (port 587) and outlook.office365.com (port 993)",
    baseUrl: "",
    docsUrl: "https://support.google.com/accounts/answer/185833",
    secretName: "SMTP_PASS",
    endpoints: [
      { name: "Send Email", method: "POST", path: "smtp", description: "Send an email via SMTP" },
      { name: "Read Inbox", method: "GET", path: "imap", description: "Read emails from IMAP inbox" },
      { name: "Search Email", method: "GET", path: "imap/search", description: "Search emails by subject/sender" },
    ],
    headers: {},
    enabled: true,
    installed: false,
    builtin: true,
  },
];

// ── Integration Registry ──

export class IntegrationRegistry {
  private filePath: string;
  private integrations: Map<string, IntegrationConfig> = new Map();

  constructor(dataDir: string) {
    this.filePath = join(dataDir, "integrations.json");
    this.load();
  }

  private load(): void {
    // Start with built-in integrations
    for (const config of BUILTIN_INTEGRATIONS) {
      this.integrations.set(config.id, { ...config });
    }

    // Overlay saved state (installed status, user-added integrations)
    if (existsSync(this.filePath)) {
      try {
        const saved = JSON.parse(readFileSync(this.filePath, "utf-8"));
        if (!Array.isArray(saved)) throw new Error("Invalid integrations config");
        for (const s of saved as IntegrationConfig[]) {
          const existing = this.integrations.get(s.id);
          if (existing) {
            // Merge saved state into built-in (preserve built-in endpoints but keep user's installed/enabled state)
            existing.installed = s.installed;
            existing.enabled = s.enabled;
            if (s.secretName) existing.secretName = s.secretName;
          } else {
            // User-added integration
            this.integrations.set(s.id, s);
          }
        }
      } catch {}
    }
  }

  private save(): void {
    const arr = Array.from(this.integrations.values());
    writeFileSync(this.filePath, JSON.stringify(arr, null, 2), { encoding: "utf-8", mode: 0o600 });
  }

  /** List all integrations (for UI) */
  list(): IntegrationConfig[] {
    return Array.from(this.integrations.values());
  }

  /** Get a single integration by ID */
  get(id: string): IntegrationConfig | undefined {
    return this.integrations.get(id);
  }

  /** Mark an integration as installed (user has saved credentials) */
  markInstalled(id: string, installed: boolean): boolean {
    const config = this.integrations.get(id);
    if (!config) return false;
    config.installed = installed;
    this.save();
    return true;
  }

  /** Enable or disable an integration */
  setEnabled(id: string, enabled: boolean): boolean {
    const config = this.integrations.get(id);
    if (!config) return false;
    config.enabled = enabled;
    this.save();
    return true;
  }

  /** Add a new custom integration (agent-discovered or user-created) */
  addIntegration(config: IntegrationConfig): void {
    config.builtin = false;
    if (config.baseUrl) {
      try {
        const u = new URL(config.baseUrl);
        // Only allow http(s) — block file://, gopher://, data:, etc.
        if (u.protocol !== "http:" && u.protocol !== "https:") {
          throw new Error("Only http and https URLs are allowed as integration base URL");
        }
        if (u.hostname === "localhost" || u.hostname === "127.0.0.1" || u.hostname === "0.0.0.0" || u.hostname === "[::1]" || u.hostname.endsWith(".local") || /^(10\.|172\.(1[6-9]|2\d|3[01])\.|192\.168\.)/.test(u.hostname) || u.hostname === "169.254.169.254" || u.hostname.endsWith(".internal")) {
          throw new Error("Internal URLs not allowed as integration base URL");
        }
      } catch (e) {
        if ((e as Error).message.includes("not allowed") || (e as Error).message.includes("Only http")) throw e;
      }
    }
    this.integrations.set(config.id, config);
    this.save();
  }

  /** Remove a user-added integration (can't remove built-ins) */
  removeIntegration(id: string): boolean {
    const config = this.integrations.get(id);
    if (!config || config.builtin) return false;
    this.integrations.delete(id);
    this.save();
    return true;
  }

  /** Update an integration's config (only safe fields) */
  updateIntegration(id: string, updates: Partial<IntegrationConfig>): boolean {
    const config = this.integrations.get(id);
    if (!config) return false;
    // Whitelist updatable fields — prevent overwriting secretName, baseUrl, builtin, endpoints
    const safeFields = ["enabled", "installed", "name", "description", "icon", "category"] as const;
    for (const field of safeFields) {
      if (field in updates) {
        (config as any)[field] = (updates as any)[field];
      }
    }
    this.save();
    return true;
  }

  /** Get integration configs formatted for the agent's system prompt */
  getAgentContext(): string {
    const installed = Array.from(this.integrations.values()).filter(i => i.installed && i.enabled);
    if (installed.length === 0) return "";

    let ctx = "\n## Connected API Integrations\n";
    ctx += "These APIs are configured and ready to use via the http_request tool.\n";
    ctx += "Use the secret name as {{SECRET_NAME}} in Authorization headers.\n\n";

    for (const i of installed) {
      ctx += `### ${i.icon} ${i.name} (${i.id})\n`;
      ctx += `Base URL: ${i.baseUrl}\n`;
      ctx += `Auth: {{${i.secretName}}} as ${i.authType === "bearer_token" || i.authType === "bot_token" ? "Bearer token" : i.authType}\n`;
      if (i.headers && Object.keys(i.headers).length > 0) {
        ctx += `Extra headers: ${JSON.stringify(i.headers)}\n`;
      }
      ctx += `Endpoints:\n`;
      for (const ep of i.endpoints) {
        ctx += `- ${ep.method} ${ep.path} — ${ep.description}\n`;
      }
      ctx += "\n";
    }

    return ctx;
  }

  /** Generate the JSON schema for a new integration (for agent discovery) */
  static getIntegrationSchema(): string {
    return JSON.stringify({
      id: "unique-slug",
      name: "Service Name",
      icon: "emoji",
      description: "What this API does",
      authType: "api_key | bearer_token | oauth2 | bot_token",
      authInstructions: "Step-by-step instructions to get credentials",
      baseUrl: "https://api.example.com",
      docsUrl: "https://docs.example.com",
      secretName: "SERVICE_API_KEY",
      scopes: ["optional", "oauth", "scopes"],
      endpoints: [
        { name: "Action Name", method: "GET", path: "/endpoint", description: "What it does", params: {} }
      ],
      headers: {},
      enabled: true,
      installed: false,
      builtin: false,
    }, null, 2);
  }
}
