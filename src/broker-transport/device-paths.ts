// The HTTP path allowlist for a remote (phone) principal reaching the desktop
// over the broker http-tunnel. This is the security boundary the broker phone
// is held to: it can read the app viewer/state and its OWN conversations (the
// phone shows the same chat history + list as the desktop — load history then
// subscribe for the live tail, like the web client). It also reads the media
// that conversation references: /uploads (photos it attached) plus /videos and
// /images (media the agent generated) — without these a generated video/image
// renders as a dead placeholder on the phone.
//
// /files (the workspace) is in since 2026-10-24, by the owner's call: a reply
// that links a workspace document left the phone with nothing to open, and the
// paired phone already reaches further than this (it drives the agent, which
// reads the workspace, and Live Screen drives the desktop). Credential files are
// still refused here, so a phone never pulls a key or .env out of the workspace.
// /api/workspace/browse lists a workspace folder for the phone's file explorer;
// it lists no credential file and follows no link out (routes/workspace-files.ts).
// /api/code-folders lists the code-session folders and adds one (routes/agents/
// projects.ts), so a code session started on the phone works in a folder: it
// exposes a folder's id, name and path, and no other project field or route.
// The broker phone is NOT an operator: nothing else on the operator API is in.

import { isSensitivePath } from "../data-lineage/index.js";

/** Endpoints the broker http-tunnel may proxy to loopback. */
export const DEVICE_HTTP_PREFIXES = ["/api/apps", "/apps/", "/api/sessions", "/api/providers", "/uploads/", "/videos/", "/images/", "/files/", "/api/workspace/browse", "/api/code-folders"];

export function isDeviceAllowedPath(pathname: string): boolean {
  if (!DEVICE_HTTP_PREFIXES.some((p) => pathname === p || pathname.startsWith(p))) return false;
  if (!pathname.startsWith("/files/")) return true;
  let rel: string;
  try {
    rel = decodeURIComponent(pathname.slice("/files/".length));
  } catch {
    return false; // malformed escape: not a path anyone can name
  }
  return rel !== "" && !isSensitivePath(rel);
}
