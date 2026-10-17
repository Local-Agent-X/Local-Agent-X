// GENERATED from src/desktop-contract/loopback-app-url.ts by scripts/check-desktop-contract.mjs --sync. Do not edit.
// The one URL shape the desktop will load on the server's behalf (the app
// probe window): plain http, a loopback host, no userinfo. Checked by the
// sender (src/desktop-bridge.ts) and again by the loadURL sink (desktop/src/
// server-bridge.ts), which must never trust the child's URL blindly. Parsed
// with the URL host grammar, not a string prefix: `http://127.0.0.1:80@evil.com/`
// has host `evil.com` — the `127.0.0.1` is userinfo — so a prefix test would
// wave it through and the probe would load, and screenshot, a remote origin.

export function isLoopbackAppUrl(url: string): boolean {
  let u: URL;
  try { u = new URL(url); } catch { return false; }
  if (u.protocol !== "http:") return false;
  if (u.username || u.password) return false;
  const host = u.hostname.toLowerCase();
  // Exactly the two hosts LAX serves apps on — a deliberately tight allowlist.
  return host === "127.0.0.1" || host === "localhost";
}
