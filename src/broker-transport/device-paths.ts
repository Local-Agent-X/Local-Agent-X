// The HTTP path allowlist for a remote (phone) principal reaching the desktop
// over the broker http-tunnel. This is the security boundary the broker phone
// is held to: it can read the app viewer/state and its OWN conversations (the
// phone shows the same chat history + list as the desktop — load history then
// subscribe for the live tail, like the web client). It also reads the media
// that conversation references: /uploads (photos it attached) plus /videos and
// /images (media the agent generated) — without these a generated video/image
// renders as a dead placeholder on the phone. /files stays out (broader
// filesystem reach). Keep this narrow — the broker phone is NOT an operator.

/** Endpoints the broker http-tunnel may proxy to loopback. */
export const DEVICE_HTTP_PREFIXES = ["/api/apps", "/apps/", "/api/sessions", "/api/providers", "/uploads/", "/videos/", "/images/"];

export function isDeviceAllowedPath(pathname: string): boolean {
  return DEVICE_HTTP_PREFIXES.some((p) => pathname === p || pathname.startsWith(p));
}
