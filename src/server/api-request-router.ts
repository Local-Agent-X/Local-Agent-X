import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";
import { parseMultipart, jsonResponse } from "../server-utils.js";
import { handleSessionRoutes, handleSecurityRoutes, handleMemoryRoutes, handleMemoryLearningRoutes, handleAgentRoutes, handleApprovalRoutes, handleIssueRoutes, handleRunsRoutes, handleAppRoutes, handleSettingsRoutes, handleBridgeRoutes, handleChatRoutes, handleMcpRoutes, handleMcpServerRoutes, handleAutopilotRoutes, handleConnectorProxyRoutes, handleHealthRoutes, handleAccountRoutes, handleArtifactRoutes, handleBrowserProfileRoutes, handleBrowserHistoryRoutes, handleBrowserBookmarkRoutes, handleBrowserDenyReasonRoutes } from "../routes/index.js";
import type { LAXConfig } from "../types.js";
import type { Role } from "../rbac.js";
import type { ServerContext } from "../server-context.js";

const ROUTE_HANDLERS = [
  handleHealthRoutes, handleAccountRoutes, handleSessionRoutes, handleChatRoutes,
  handleMemoryLearningRoutes, handleMemoryRoutes, handleSecurityRoutes, handleAgentRoutes, handleApprovalRoutes, handleIssueRoutes,
  handleRunsRoutes, handleAppRoutes, handleBridgeRoutes, handleSettingsRoutes,
  handleMcpRoutes, handleMcpServerRoutes, handleAutopilotRoutes, handleConnectorProxyRoutes,
  handleArtifactRoutes, handleBrowserProfileRoutes, handleBrowserHistoryRoutes, handleBrowserBookmarkRoutes,
  handleBrowserDenyReasonRoutes,
];

const UPLOAD_MAGIC: Record<string, Buffer[]> = {
  png: [Buffer.from([0x89, 0x50, 0x4E, 0x47])],
  jpg: [Buffer.from([0xFF, 0xD8, 0xFF])],
  jpeg: [Buffer.from([0xFF, 0xD8, 0xFF])],
  gif: [Buffer.from("GIF87a"), Buffer.from("GIF89a")],
  webp: [Buffer.from("RIFF")], bmp: [Buffer.from("BM")], pdf: [Buffer.from("%PDF")],
};
const BLOCKED_UPLOAD_EXTENSIONS = new Set(["exe", "sh", "bat", "cmd", "com", "ps1", "vbs", "js", "msi", "dll", "so"]);

export async function routeApiRequest(
  method: string,
  url: URL,
  req: IncomingMessage,
  res: ServerResponse,
  ctx: ServerContext,
  requestRole: Role,
  config: LAXConfig,
  dataDir: string,
): Promise<boolean> {
  for (const handler of ROUTE_HANDLERS) {
    if (await handler(method, url, req, res, ctx, requestRole)) return true;
  }
  const json = (status: number, data: unknown) => jsonResponse(res, status, data, req);

  if (method === "POST" && url.pathname === "/api/upload") {
    const uploadsDir = join(dataDir, "uploads");
    mkdirSync(uploadsDir, { recursive: true });
    const chunks: Buffer[] = [];
    let totalSize = 0;
    for await (const chunk of req) {
      totalSize += (chunk as Buffer).length;
      if (totalSize > config.maxUploadBytes) {
        json(413, { error: `File too large. Max ${Math.round(config.maxUploadBytes / 1048576)}MB.` });
        req.destroy();
        return true;
      }
      chunks.push(chunk as Buffer);
    }
    const contentType = req.headers["content-type"] || "";
    const boundaryMatch = contentType.match(/boundary=(?:"([^"]{1,70})"|([^\s;]{1,70}))/);
    if (!boundaryMatch) { json(400, { error: "Multipart form data required" }); return true; }
    const boundary = boundaryMatch[1] || boundaryMatch[2];
    if (!boundary || boundary.length > 70 || /[^\x20-\x7e]/.test(boundary)) {
      json(400, { error: "Invalid boundary" });
      return true;
    }
    const uploaded: { name: string; url: string; size: number; isImage: boolean }[] = [];
    for (const part of parseMultipart(Buffer.concat(chunks), boundary)) {
      const ext = (part.filename?.split(".").pop() || "bin").toLowerCase().replace(/[^a-z0-9]/g, "");
      if (BLOCKED_UPLOAD_EXTENSIONS.has(ext)) { json(400, { error: `File type .${ext} not allowed` }); return true; }
      const signatures = UPLOAD_MAGIC[ext];
      if (signatures && !signatures.some(sig => part.data.length >= sig.length && part.data.subarray(0, sig.length).equals(sig))) {
        json(400, { error: `File ${part.filename} doesn't match type .${ext}` });
        return true;
      }
      const safeName = `${createHash("sha256").update(part.data).digest("hex")}.${ext}`;
      const destination = join(uploadsDir, safeName);
      if (!existsSync(destination)) writeFileSync(destination, part.data);
      uploaded.push({
        name: part.filename || safeName,
        url: `/uploads/${safeName}`,
        size: part.data.length,
        isImage: /^(png|jpg|jpeg|gif|webp|svg|bmp)$/.test(ext),
      });
    }
    json(200, { files: uploaded });
    return true;
  }
  if (url.pathname === "/api/uploads/stats" && method === "GET") {
    const uploadsDir = join(dataDir, "uploads");
    let count = 0;
    let bytes = 0;
    if (existsSync(uploadsDir)) {
      for (const filename of readdirSync(uploadsDir)) {
        const stat = statSync(join(uploadsDir, filename));
        if (stat.isFile()) { count++; bytes += stat.size; }
      }
    }
    json(200, { count, bytes });
    return true;
  }
  if (url.pathname === "/api/uploads" && method === "DELETE") {
    const uploadsDir = join(dataDir, "uploads");
    let removed = 0;
    if (existsSync(uploadsDir)) {
      for (const filename of readdirSync(uploadsDir)) {
        const file = join(uploadsDir, filename);
        if (statSync(file).isFile()) { unlinkSync(file); removed++; }
      }
    }
    json(200, { removed });
    return true;
  }
  return false;
}
