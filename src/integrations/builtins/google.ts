import type { IntegrationDeclaration } from "../types.js";

/**
 * The YouTube Data API — the whole of what a Google API KEY can honestly reach.
 *
 * This declaration used to advertise Gmail, Calendar and Drive alongside
 * YouTube under `authType: "api_key"`. Those five endpoints act on a signed-in
 * person's own data and need an OAuth2 user grant, which this integration has
 * no flow to obtain, so declaring them promised a capability that provably did
 * not exist and every call the model made against them would 401. The tell was
 * in POST /api/integrations/test, which hardcoded a YouTube probe: the code
 * already knew only YouTube worked.
 *
 * Resolved 2026-07-25: no OAuth2 flow. The integration is narrowed to what the
 * key can satisfy rather than left over-promising. C4's `authScope: "user"`
 * annotations are gone WITH the endpoints they marked — the feasibility filter
 * in registry.getAgentContext() is now a no-op for google, because every
 * endpoint it declares is reachable.
 *
 * `id` and the credential NAME are load-bearing and deliberately unchanged:
 * `id` is persisted in ~/.lax/integrations.json and GOOGLE_API_KEY is a live
 * vault entry, so anyone who already installed this keeps both their install
 * and their key. Only the claims shrink.
 *
 * `scopes` is REMOVED rather than trimmed. It listed gmail.modify / calendar /
 * drive — OAuth2 scopes an api_key cannot grant — and YouTube search over an
 * api_key carries no scope at all, so the honest value is none, not a shorter
 * false list.
 *
 * `headers` is where the credential's PLACEMENT is now declared. The YouTube
 * Data API takes the key as `X-Goog-Api-Key` (or `?key=`) and NEVER as a bearer
 * token, and `{{SECRET_NAME}}` is the placeholder convention that both
 * http_request and the integration test route already resolve. That one line is
 * what lets both authenticate without either of them knowing the string
 * "google" — and it is also the only thing that told the model where its key
 * goes, which the old declaration never did.
 */
export const googleIntegration: IntegrationDeclaration = {
  id: "google",
  name: "YouTube Data API",
  icon: "🔍",
  description: "Search YouTube videos, channels and playlists with a Google API key",
  authType: "api_key",
  authInstructions: "1. Go to console.cloud.google.com\n2. Create a project\n3. Enable the YouTube Data API v3\n4. Create credentials → API key\n5. Copy the API key",
  baseUrl: "https://www.googleapis.com",
  docsUrl: "https://developers.google.com/youtube/v3/docs/search/list",
  credentials: [{ name: "GOOGLE_API_KEY" }],
  endpoints: [
    // `part` is required by the API and was missing from this declaration, so
    // the model was being taught a call shape that 400s. It is an enum of
    // resource-part names, not free text.
    { name: "Search YouTube", method: "GET", path: "/youtube/v3/search", description: "Search YouTube videos", params: { part: { type: "string", required: true, description: "Resource parts to return — use \"snippet\"" }, q: { type: "string", required: true, description: "Search query" }, maxResults: { type: "number", description: "Max results" }, type: { type: "string", description: "video, channel, or playlist" } } },
  ],
  headers: { "X-Goog-Api-Key": "{{GOOGLE_API_KEY}}" },
  enabled: true,
  installed: false,
  builtin: true,
};
