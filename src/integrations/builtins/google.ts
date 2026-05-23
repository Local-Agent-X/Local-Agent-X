import type { IntegrationConfig } from "../types.js";

export const googleIntegration: IntegrationConfig = {
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
};
