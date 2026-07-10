import { timingSafeEqual } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";
import { corsHeaders, jsonResponse } from "../server-utils.js";
import { confineToDir } from "../security/file-access.js";
import { getPageBundle } from "./static-bundle.js";
import type { LAXConfig } from "../types.js";

const UPLOAD_CONTENT_TYPES: Record<string, string> = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp", svg: "image/svg+xml", bmp: "image/bmp", pdf: "application/pdf", txt: "text/plain", json: "application/json", csv: "text/csv" };
const MEDIA_CONTENT_TYPES: Record<string, string> = { mp4: "video/mp4", webm: "video/webm", png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp", svg: "image/svg+xml" };
const FILE_CONTENT_TYPES: Record<string, string> = { docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation", pdf: "application/pdf", txt: "text/plain", json: "application/json", csv: "text/csv", md: "text/markdown", png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp", svg: "image/svg+xml", mp4: "video/mp4", webm: "video/webm", mp3: "audio/mpeg", html: "text/html", css: "text/css", js: "application/javascript" };
const INLINEABLE_FILES = new Set(["png", "jpg", "jpeg", "gif", "webp", "svg", "pdf", "txt", "json", "csv", "md", "html", "css", "js", "mp4", "webm"]);

export function serveProtectedAssets(method: string, url: URL, req: IncomingMessage, res: ServerResponse, config: LAXConfig, dataDir: string): boolean {
  const json = (status: number, data: unknown) => jsonResponse(res, status, data, req);
  if (method !== "GET") return false;
  if (!["/uploads/", "/videos/", "/images/", "/files/"].some(route => url.pathname.startsWith(route))) return false;

  const authorization = req.headers.authorization || "";
  const provided = (authorization.startsWith("Bearer ") ? authorization.slice(7) : "") || url.searchParams.get("token") || "";
  const operatorOk = !!provided && provided.length === config.authToken.length && timingSafeEqual(Buffer.from(provided), Buffer.from(config.authToken));
  if (!operatorOk) { json(401, { error: "Authentication required" }); return true; }

  if (url.pathname.startsWith("/uploads/")) {
    const filename = url.pathname.replace("/uploads/", "");
    if (/[^a-zA-Z0-9._-]/.test(filename)) { json(400, { error: "Invalid filename" }); return true; }
    const file = confineToDir(join(dataDir, "uploads"), filename);
    if (!file) { json(403, { error: "Path traversal blocked" }); return true; }
    if (!existsSync(file)) { json(404, { error: "File not found" }); return true; }
    const ext = filename.split(".").pop() || "";
    const headers: Record<string, string> = { ...corsHeaders(req), "Content-Type": UPLOAD_CONTENT_TYPES[ext] || "application/octet-stream", "Cache-Control": "public, max-age=31536000, immutable", "X-Content-Type-Options": "nosniff" };
    if (ext === "svg") headers["Content-Security-Policy"] = "script-src 'none'";
    res.writeHead(200, headers); res.end(readFileSync(file)); return true;
  }
  for (const [prefix, subdir] of [["/videos/", "videos"], ["/images/", "images"]] as const) {
    if (url.pathname.startsWith(prefix)) {
      const file = confineToDir(resolve(config.workspace, subdir), url.pathname.replace(prefix, ""));
      if (!file || url.pathname.includes("\x00")) { json(403, { error: "Path traversal blocked" }); return true; }
      if (existsSync(file)) {
        const ext = file.split(".").pop() || "";
        res.writeHead(200, { "Content-Type": MEDIA_CONTENT_TYPES[ext] || "application/octet-stream" });
        res.end(readFileSync(file));
        return true;
      }
      json(404, { error: "File not found", path: url.pathname, checked: file, workspace: config.workspace });
      return true;
    }
  }
  if (url.pathname.startsWith("/files/")) {
    const filePath = decodeURIComponent(url.pathname.slice(7));
    const file = confineToDir(resolve(config.workspace), filePath);
    if (!file || filePath.includes("\x00")) { json(403, { error: "Path traversal blocked" }); return true; }
    if (!existsSync(file)) { json(404, { error: "File not found" }); return true; }
    const ext = (file.split(".").pop() || "").toLowerCase();
    const filename = file.split(/[/\\]/).pop() || "download";
    const headers: Record<string, string> = { ...corsHeaders(req), "Content-Type": FILE_CONTENT_TYPES[ext] || "application/octet-stream", "X-Content-Type-Options": "nosniff" };
    if (!INLINEABLE_FILES.has(ext)) headers["Content-Disposition"] = `attachment; filename="${filename}"`;
    if (ext === "svg") headers["Content-Security-Policy"] = "script-src 'none'";
    res.writeHead(200, headers); res.end(readFileSync(file)); return true;
  }
  return false;
}

export function servePublicAsset(method: string, url: URL, req: IncomingMessage, res: ServerResponse, publicDir: string): boolean {
  if (method !== "GET") return false;
  const json = (status: number, data: unknown) => jsonResponse(res, status, data, req);
  const bundleMatch = url.pathname.match(/^\/js\/_bundle\/([a-z0-9_-]+)\.js$/i);
  if (bundleMatch) {
    const bundle = getPageBundle(bundleMatch[1], publicDir);
    if (bundle) {
      res.writeHead(200, { ...corsHeaders(req), "Content-Type": "application/javascript", "Cache-Control": "public, max-age=31536000, immutable", "X-Content-Type-Options": "nosniff" });
      res.end(bundle.body);
      return true;
    }
  }
  const file = url.pathname === "/" || url.pathname === "/index.html" || url.pathname === "/app.html" ? join(publicDir, "app.html") : join(publicDir, url.pathname);
  if (relative(publicDir, resolve(file)).startsWith("..")) { json(403, { error: "Path traversal blocked" }); return true; }
  if (!existsSync(file)) return false;
  const ext = file.split(".").pop() || "";
  const contentTypes: Record<string, string> = { html: "text/html", css: "text/css", js: "application/javascript", json: "application/json", svg: "image/svg+xml", png: "image/png", ico: "image/x-icon" };
  const headers: Record<string, string> = { "Content-Type": contentTypes[ext] || "application/octet-stream" };
  if (ext === "html") {
    headers["Content-Security-Policy"] = "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self' http://127.0.0.1:* http://localhost:* ws://127.0.0.1:* ws://localhost:*; media-src 'self' blob: mediastream:; frame-src 'self' http://127.0.0.1:* http://localhost:*; frame-ancestors 'self'; object-src 'none'; base-uri 'self'; form-action 'self'";
    headers["X-Content-Type-Options"] = "nosniff"; headers["X-Frame-Options"] = "SAMEORIGIN"; headers["Referrer-Policy"] = "no-referrer"; headers["Permissions-Policy"] = "camera=(self), microphone=(self), geolocation=()";
    headers["Cache-Control"] = "no-cache, must-revalidate"; headers["Pragma"] = "no-cache";
    const raw = readFileSync(file, "utf-8");
    const page = (file.split(/[/\\]/).pop() || "").replace(/\.html$/i, "");
    const bundle = getPageBundle(page, publicDir, raw);
    res.writeHead(200, headers); res.end(bundle ? bundle.rewrittenHtml : raw); return true;
  }
  res.writeHead(200, headers); res.end(readFileSync(file)); return true;
}
