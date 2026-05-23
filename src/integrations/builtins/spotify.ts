import type { IntegrationConfig } from "../types.js";

export const spotifyIntegration: IntegrationConfig = {
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
};
